/*
   build-wikivecs-multithread.js — Multi-threaded Phase 1: split + embed + insert.

   Splits the wikitext table across N threads, each with its own
   embedding model instance and SQL connection.

   After this completes, run build-wikivecs.js to do the FAISS build
   (it will detect the populated wikivecs table and skip to Phase 2).

   Usage:  rampart build-wikivecs-multithread.js [lang_code] [num_threads]
*/

var Sql = require("rampart-sql");
var thread = rampart.thread;

rampart.globalize(rampart.utils);

var nCpu = parseInt(process.argv[3]) || process.nCpu || 4;
var lc = "en";
if (process.argv.length > 2 && process.argv[2].length)
    lc = process.argv[2];

var dbPath = process.scriptPath + "/web_server/data/" + lc + "_wikipedia_search";
var modelFile = "all-minilm-l6-v2_f16.gguf";
var vecDim = 384;

if (!stat(modelFile)) {
    fprintf(stderr, "Model '%s' not found. Download it first.\n", modelFile);
    process.exit(1);
}

function formatTime(seconds) {
    if (seconds < 60) return seconds.toFixed(0) + "s";
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    if (m < 60) return m + "m" + (s < 10 ? "0" : "") + s + "s";
    var h = Math.floor(m / 60);
    m = m % 60;
    return h + "h" + (m < 10 ? "0" : "") + m + "m";
}

/* ================================================================
   Step 1: Count articles and set up the table
   ================================================================ */

printf("build-wikivecs-multithread.js\n");
printf("Database: %s\n", dbPath);
printf("Model: %s\n", modelFile);
printf("Started: %s\n\n", dateFmt('%c %z'));

var sql = new Sql.init(dbPath, true);

var res = sql.one("select count(Id) cnt from wikitext");
var totalArticles = res.cnt;
printf("Articles in wikitext: %d\n", totalArticles);

/* Create wikivecs table if it doesn't exist */
if (!sql.one("select * from SYSTABLES where NAME='wikivecs'")) {
    sql.query("create table wikivecs (Idsec uint64, Vec varbyte(" + vecDim + "), Title varchar(16), Text varchar(256))");
    printf("Created table wikivecs\n");
} else {
    var existing = sql.one("select count(Idsec) cnt from wikivecs");
    if (existing && existing.cnt > 0) {
        printf("\nwikivecs already has %d rows.\n", existing.cnt);
        printf("  [d] Drop and rebuild from scratch\n");
        printf("  [s] Skip (exit)\n");
        var resp = null;
        function getresp(def) {
            var ret = stdin.getchar(1);
            if (ret == '\n') return def;
            printf("\n");
            return ret.toLowerCase();
        }
        printf("Choice (d/s): ");
        fflush(stdout);
        resp = getresp("s");
        if (resp === 'd') {
            printf("Dropping wikivecs...\n");
            sql.query("drop table wikivecs");
            sql.query("create table wikivecs (Idsec uint64, Vec varbyte(" + vecDim + "), Title varchar(16), Text varchar(256))");
        } else {
            printf("Exiting. Run build-wikivecs.js to proceed to FAISS build.\n");
            process.exit(0);
        }
    }
}

/* ================================================================
   Step 2: Divide work into ranges for each thread
   ================================================================ */

var rowsPerThread = Math.ceil(totalArticles / nCpu);
var ranges = [];
for (var i = 0; i < nCpu; i++) {
    var skip = i * rowsPerThread;
    if (skip >= totalArticles) break;
    var max = Math.min(rowsPerThread, totalArticles - skip);
    ranges.push({ skip: skip, max: max });
}
var numThreads = ranges.length;

printf("\n%d threads, ~%d articles each\n\n", numThreads, rowsPerThread);

/* ================================================================
   Step 3: Launch worker threads
   ================================================================ */

/* Globals copied to threads (set BEFORE thread creation) */
var g_dbPath = dbPath;
var g_modelFile = modelFile;
var g_vecDim = vecDim;
var g_splitterPath = process.scriptPath + "/wikiparser/splitter.js";

var threads = [];
for (var i = 0; i < numThreads; i++) {
    threads.push(new thread(true));
}

var startTime = performance.now();
var threadsFinished = 0;

/*
   Worker function — runs in each thread.
   Each thread loads its own embedding model, SQL connection, and splitter.
*/
function workerFunc(arg) {
    rampart.globalize(rampart.utils);

    var Sql = require("rampart-sql");
    var llamacpp = require("rampart-llamacpp");
    var splitter = require(g_splitterPath);

    var myId = arg.id;
    var sql = new Sql.init(g_dbPath, false);
    var emb = llamacpp.initEmbed(g_modelFile);

    var myCount = 0, myChunks = 0, mySkipped = 0;
    var emaRate = 0, lastCount = 0, lastTime = 0;
    var myStartTime = performance.now();

    rampart.thread.put("progress_" + myId, {
        id: myId, docs: 0, chunks: 0, skipped: 0, total: arg.max,
        rate: 0, elapsed: 0, pct: 0
    });

    sql.exec("select Id, Title, Doc from wikitext",
        {skipRows: arg.skip, maxRows: arg.max},
        function(row) {
            var parts = splitter.split(row.Id, row.Title, row.Doc);
            if (!parts.length) {
                mySkipped++;
                myCount++;
            } else {
                for (var i = 0; i < parts.length; i++) {
                    var x = emb.embedTextToFp16Buf(parts[i].text);
                    sql.one("insert into wikivecs values(?,?,?,?)",
                        [parts[i].idSec, x.avgVec, row.Title, parts[i].text]);
                    myChunks++;
                }
                myCount++;
            }

            if (!(myCount % 50)) {
                var elapsed = (performance.now() - myStartTime) / 1000;
                if (lastTime > 0) {
                    var dt = elapsed - lastTime;
                    var dc = myCount - lastCount;
                    if (dt > 0) {
                        var ir = dc / dt;
                        emaRate = emaRate > 0 ? emaRate * 0.95 + ir * 0.05 : ir;
                    }
                }
                lastCount = myCount;
                lastTime = elapsed;

                rampart.thread.put("progress_" + myId, {
                    id: myId,
                    docs: myCount,
                    chunks: myChunks,
                    skipped: mySkipped,
                    total: arg.max,
                    rate: emaRate,
                    elapsed: elapsed,
                    pct: myCount / arg.max * 100
                });
            }
        }
    );

    var finalElapsed = (performance.now() - myStartTime) / 1000;
    rampart.thread.put("progress_" + myId, {
        id: myId,
        docs: myCount,
        chunks: myChunks,
        skipped: mySkipped,
        total: arg.max,
        rate: myCount / finalElapsed,
        elapsed: finalElapsed,
        pct: 100,
        done: true
    });

    return { docs: myCount, chunks: myChunks, skipped: mySkipped };
}

function workerDone(result, err) {
    threadsFinished++;
    if (err) fprintf(stderr, "Thread error: %s\n", err);
}

/* Launch all workers */
for (var i = 0; i < numThreads; i++) {
    threads[i].exec(workerFunc, {
        id: i,
        skip: ranges[i].skip,
        max: ranges[i].max
    }, workerDone);
}

/* ================================================================
   Progress display using %M (multiline print)
   ================================================================ */

var progressData = [];
for (var i = 0; i < numThreads; i++) {
    progressData.push({id: i, docs: 0, chunks: 0, skipped: 0, total: ranges[i].max, rate: 0, elapsed: 0, pct: 0});
}

var pollInterval = setInterval(function() {
    if (threadsFinished >= numThreads) {
        clearInterval(pollInterval);

        /* Final display */
        var totalDocs = 0, totalChunks = 0, totalSkipped = 0;
        var finalLines = [];
        var thrWidth = String(numThreads - 1).length;
        var countWidth = String(progressData[0].total).length;

        for (var i = 0; i < numThreads; i++) {
            var p = rampart.thread.get("progress_" + i);
            if (p) progressData[i] = p;
            var pd = progressData[i];
            totalDocs += pd.docs;
            totalChunks += pd.chunks;
            totalSkipped += pd.skipped;
            finalLines.push(sprintf("  Thread %*d: %*d / %d docs | %d chunks | %4.0f/sec DONE",
                thrWidth, i, countWidth, pd.docs, pd.total, pd.chunks, pd.rate || 0));
        }

        var elapsed = (performance.now() - startTime) / 1000;
        finalLines.push("");
        finalLines.push(sprintf("  TOTAL: %d / %d docs | %d chunks | %d skipped | %.0f docs/sec | %s",
            totalDocs, totalArticles, totalChunks, totalSkipped,
            totalDocs / elapsed, formatTime(elapsed)));
        printf("%M", finalLines);

        printf("\n\nDone: %d docs → %d chunks in %s (%.0f docs/sec across %d threads)\n",
            totalDocs, totalChunks, formatTime(elapsed), totalDocs / elapsed, numThreads);
        printf("Avg %.1f chunks/doc, %d skipped (%.1f%%)\n",
            totalChunks / totalDocs, totalSkipped, totalSkipped / totalDocs * 100);
        printf("Finished: %s\n\n", dateFmt('%c %z'));
        printf("Now run: rampart build-wikivecs.js %s\n", lc);

        for (var i = 0; i < numThreads; i++) threads[i].close();
        return;
    }

    /* Read progress and display */
    var lines = [];
    var totalDocs = 0, totalChunks = 0, totalTotal = 0;
    var maxEtaSeconds = 0;
    var thrWidth = String(numThreads - 1).length;
    var countWidth = String(progressData[0].total).length;

    for (var i = 0; i < numThreads; i++) {
        var p = rampart.thread.get("progress_" + i);
        if (p) progressData[i] = p;
        var pd = progressData[i];
        totalDocs += pd.docs;
        totalChunks += pd.chunks;
        totalTotal += pd.total;

        var eta = "";
        if (pd.rate > 0 && pd.pct < 100) {
            var secs = (pd.total - pd.docs) / pd.rate;
            eta = "  ETA: " + formatTime(secs);
            if (secs > maxEtaSeconds) maxEtaSeconds = secs;
        }
        var status = pd.done ? " DONE" : "";
        lines.push(sprintf("  Thread %*d: %*d / %d docs | %6d chunks | %4.0f/sec%s%s",
            thrWidth, i, countWidth, pd.docs, pd.total, pd.chunks,
            pd.rate || 0, eta, status));
    }

    var overallElapsed = (performance.now() - startTime) / 1000;
    var overallRate = overallElapsed > 0 ? totalDocs / overallElapsed : 0;
    var overallEta = maxEtaSeconds > 0
        ? formatTime(maxEtaSeconds)
        : (overallRate > 0 ? formatTime((totalTotal - totalDocs) / overallRate) : "starting...");
    lines.push("");
    lines.push(sprintf("  TOTAL: %*d / %d docs | %d chunks | %.0f/sec | %s elapsed | ETA: %s",
        countWidth, totalDocs, totalArticles, totalChunks,
        overallRate, formatTime(overallElapsed), overallEta));

    printf("%M", lines);
}, 2000);
