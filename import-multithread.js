/*
    import-multithread.js — Multi-threaded Wikipedia import.

    Scans a Wikipedia XML dump, expands templates, and imports into
    a Rampart SQL full-text search database using multiple threads.

    Usage:  rampart import-multithread.js [lang_code]
*/

var Sql = require("rampart-sql");
var Lmdb = require("rampart-lmdb");
var wikiparser = require(process.scriptPath + "/wikiparser/wikiparser.js");
var thread = rampart.thread;

rampart.globalize(rampart.utils);

var nCpu = process.nCpu || 4;
var lc = "en";
if (process.argv.length > 2 && process.argv[2].length)
    lc = process.argv[2];

var FILE = lc + "wiki-latest-pages-articles.xml";
var lmdbPath = "./" + lc + "_wiki_index";
var dbPath = process.scriptPath + "/web_server/data/" + lc + "_wikipedia_search";

if (!stat(FILE)) {
    fprintf(stderr, "Error: dump file '%s' not found\n", FILE);
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
   Step 1: Scan the dump and build the LMDB index (if not already done)
   ================================================================ */

if (!stat(lmdbPath)) {
    var fileSizeMB = (stat(FILE).size / (1024 * 1024)).toFixed(0);
    printf("Step 1: Scanning %s (%s MB) to build index...\n", FILE, fileSizeMB);
    var scanEmaRate = 0, scanLastPos = 0, scanLastTime = 0;
    var scanResult = wikiparser.scan(FILE, lmdbPath, {
        progressCallback: function(p) {
            if (scanLastTime > 0) {
                var dt = p.elapsed - scanLastTime;
                var dp = p.filePos - scanLastPos;
                if (dt > 0) {
                    var ir = dp / dt;
                    scanEmaRate = scanEmaRate > 0 ? scanEmaRate * 0.95 + ir * 0.05 : ir;
                }
            }
            scanLastPos = p.filePos;
            scanLastTime = p.elapsed;
            var eta = scanEmaRate > 0 ? "  ETA: " + formatTime((p.fileSize - p.filePos) / scanEmaRate) : "";
            printf("  %d pages | %s%% | %.0f/sec | %s elapsed%s          \r",
                p.count, p.pct.toFixed(1), p.rate, formatTime(p.elapsed), eta);
            fflush(stdout);
        },
        progressInterval: 10000
    });
    printf("  %d pages indexed in %s                                    \n",
        scanResult.pages, formatTime(scanResult.elapsed));
    printf("  Site: %s (%s)\n\n", scanResult.siteinfo.sitename, scanResult.siteinfo.dbname);
} else {
    printf("Step 1: Index already exists at %s (skipping scan)\n\n", lmdbPath);
}

/* ================================================================
   Step 2: Collect all article keys and split into chunks
   ================================================================ */

printf("Step 2: Collecting article keys...\n");

var lmdb = new Lmdb.init(lmdbPath, false, { conversion: "CBOR" });
var db = lmdb.openDb("pages");

var counts = lmdb.get(db, "_meta:counts");
var totalArticles = counts ? counts.articles : 0;

/* Collect all ns=0 non-redirect article keys */
var articleKeys = [];
var txn = new lmdb.transaction(db, false);
var row = txn.cursorGet(lmdb.op_setRange, "0:", true);
while (row && row.key && row.key.indexOf("0:") === 0) {
    var entry = CBOR.decode(row.value);
    if (!entry.redirect) {
        articleKeys.push(row.key.substring(2)); /* strip "0:" prefix */
    }
    row = txn.cursorNext(true);
}
txn.abort();

totalArticles = articleKeys.length;
printf("  %d articles found\n", totalArticles);

/* Build key ranges for each thread (contiguous alphabet ranges).
   Each range is defined by startKey/endKey for wikiparser.extract(). */
var ranges = [];
var keysPerThread = Math.ceil(totalArticles / nCpu);
for (var i = 0; i < nCpu; i++) {
    var startIdx = i * keysPerThread;
    if (startIdx >= totalArticles) break;
    var endIdx = Math.min(startIdx + keysPerThread, totalArticles);
    ranges.push({
        startKey: articleKeys[startIdx],
        /* endKey is the key just past our range (or null for last thread) */
        endKey: endIdx < totalArticles ? articleKeys[endIdx] : null,
        count: endIdx - startIdx
    });
}
var numThreads = ranges.length;
articleKeys = null; /* free memory — not needed anymore */

printf("  %d threads, ~%d articles each\n\n", numThreads, keysPerThread);

/* ================================================================
   Step 3: Create/reset the SQL database
   ================================================================ */

if (!stat(process.scriptPath + "/web_server/data"))
    mkdir(process.scriptPath + "/web_server/data");

/* The main thread creates/resets the table */
var sql = new Sql.init(dbPath, true);
if (sql.errMsg.length) {
    console.log(sql.errMsg);
    if (!/^100/.test(sql.errMsg)) process.exit(1);
}

if (sql.one("select * from SYSTABLES where NAME='wikitext';")) {
    var resp = null;
    function getresp(def) {
        var ret = stdin.getchar(1);
        if (ret == '\n') return def;
        printf("\n");
        return ret.toLowerCase();
    }
    while (resp != 'y') {
        printf('Table "wikitext" exists. Delete it? (y/N): ');
        fflush(stdout);
        resp = getresp("n");
        if (resp == 'n') {
            printf('Cannot continue.\n');
            process.exit(1);
        }
    }
    sql.exec("drop table wikitext;");
}

printf("Creating table wikitext\n");
sql.exec("create table wikitext ( Id int, Title varchar(16), Doc varchar(1024) );");

/* ================================================================
   Step 4: Launch worker threads
   ================================================================ */

printf("\nStep 4: Expanding and importing with %d threads...\n\n", numThreads);

/* These globals will be copied to threads (set BEFORE thread creation) */
var g_FILE = FILE;
var g_lmdbPath = lmdbPath;
var g_dbPath = dbPath;
var g_wikiparserPath = process.scriptPath + "/wikiparser/wikiparser.js";


/* Create threads */
var threads = [];
for (var i = 0; i < numThreads; i++) {

    threads.push(new thread(true)); /* persistent */

}


var startTime = performance.now();
var threadsFinished = 0;

/*
   Worker function — runs in each thread.
   Receives: {id, startKey, endKey, count}

   Each thread gets its own wikiparser instance (with its own template
   cache and LMDB handle) and its own SQL connection.
*/
function workerFunc(arg) {
    rampart.globalize(rampart.utils);

    var Sql = require("rampart-sql");

    var wp = require(g_wikiparserPath);

    var myId = arg.id;
    var total = arg.count;
    var emaRate = 0, lastCount = 0, lastTime = 0;

    var sql = new Sql.init(g_dbPath, false);

    /* Signal that we're starting — test with direct rampart.thread.put */
    rampart.thread.put("progress_" + myId, {
        id: myId, count: 0, total: total, rate: 0, elapsed: 0, pct: 0
    });

    var myCount = 0;

    var myStartTime = performance.now();

    var extractOpts = {
        startKey: arg.startKey,
        progressInterval: 0, /* we handle progress ourselves */
        callback: function(title, id, text) {
            sql.exec("insert into wikitext values (?,?,?);",
                [parseInt(id) || 0, title, text]
            );
            myCount++;

            /* Report progress every 100 articles */
            if (!(myCount % 100)) {
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
                    count: myCount,
                    total: total,
                    rate: emaRate,
                    elapsed: elapsed,
                    pct: myCount / total * 100
                });
            }
        }
    };

    if (arg.endKey) extractOpts.endKey = arg.endKey;

    var result = wp.extract(g_FILE, g_lmdbPath, extractOpts);

    /* Final progress */
    var finalElapsed = (performance.now() - myStartTime) / 1000;
    rampart.thread.put("progress_" + myId, {
        id: myId,
        count: myCount,
        total: total,
        rate: myCount / finalElapsed,
        elapsed: finalElapsed,
        pct: 100,
        done: true
    });

    return result.articles;
}

/* Callback when a worker finishes */
function workerDone(count, err) {
    threadsFinished++;
    if (err) fprintf(stderr, "Thread error: %s\n", err);
}

/* Launch all workers */

for (var i = 0; i < numThreads; i++) {

    threads[i].exec(workerFunc, {
        id: i,
        startKey: ranges[i].startKey,
        endKey: ranges[i].endKey,
        count: ranges[i].count
    }, workerDone);

}


/* ================================================================
   Progress display using %M (multiline print)
   ================================================================ */

var progressData = [];
for (var i = 0; i < numThreads; i++) {
    progressData.push({id: i, count: 0, total: ranges[i].count, rate: 0, elapsed: 0, pct: 0});
}

/* No onGet — use polling instead (more reliable across thread boundaries) */


/* Polling fallback: if onGet doesn't fire, poll progress directly */
var pollInterval = setInterval(function() {
    if (threadsFinished >= numThreads) {
        /* All worker callbacks have fired — but verify all progress
           reports show done before exiting.  A thread's callback fires
           when its JS function returns, so by this point all work is
           complete.  Read final progress and display. */
        clearInterval(pollInterval);
        var finalCount = 0;
        var finalLines = [];
        var thrWidth = String(numThreads - 1).length;
        var countWidth = String(progressData[0].total).length;
        for (var i = 0; i < numThreads; i++) {
            var p = rampart.thread.get("progress_" + i);
            if (p) { progressData[i] = p; finalCount += p.count; }
            else finalCount += progressData[i].count;
            var pd = progressData[i];
            finalLines.push(sprintf("  Thread %*d: %*d / %d (%5.1f%%) | %4.0f/sec DONE",
                thrWidth, i, countWidth, pd.count, pd.total, pd.count/pd.total*100,
                pd.rate || 0));
        }
        var elapsed = (performance.now() - startTime) / 1000;
        finalLines.push("");
        finalLines.push(sprintf("  TOTAL: %*d / %d (%.1f%%) | %.0f/sec | %s elapsed",
            countWidth, finalCount, totalArticles,
            totalArticles > 0 ? finalCount / totalArticles * 100 : 0,
            finalCount / elapsed, formatTime(elapsed)));
        printf("%M", finalLines);
        if (finalCount < totalArticles) {
            printf("\n\n  Done: %d of %d articles imported in %s (%.0f/sec across %d threads)\n",
                finalCount, totalArticles, formatTime(elapsed), finalCount / elapsed, numThreads);
            printf("  %d articles could not be processed (%.1f%% — complex templates or errors)\n",
                totalArticles - finalCount, (totalArticles - finalCount) / totalArticles * 100);
        } else {
            printf("\n\n  Done: %d articles imported in %s (%.0f/sec across %d threads)\n",
                finalCount, formatTime(elapsed), finalCount / elapsed, numThreads);
        }
        for (var i = 0; i < numThreads; i++) threads[i].close();
        return;
    }

    /* Read progress from clipboard directly */
    var lines = [];
    var totalCount = 0, totalTotal = 0;
    var maxEtaSeconds = 0; /* track the longest remaining time */

    /* Calculate column widths based on data */
    var thrWidth = String(numThreads - 1).length;
    var countWidth = String(progressData[0].total).length;

    for (var i = 0; i < numThreads; i++) {
        var p = rampart.thread.get("progress_" + i);
        if (p) progressData[i] = p;
        var pd = progressData[i];
        totalCount += pd.count;
        totalTotal += pd.total;

        var eta = "";
        if (pd.rate > 0 && pd.pct < 100) {
            var secs = (pd.total - pd.count) / pd.rate;
            eta = "  ETA: " + formatTime(secs);
            if (secs > maxEtaSeconds) maxEtaSeconds = secs;
        }
        var status = pd.done ? " DONE" : "";
        lines.push(sprintf("  Thread %*d: %*d / %d (%5.1f%%) | %4.0f/sec%s%s",
            thrWidth, i, countWidth, pd.count, pd.total, pd.pct,
            pd.rate || 0, eta, status));
    }

    /* Overall ETA: use the longest remaining thread, not the average.
       When most threads are done, the bottleneck is the slowest one. */
    var overallElapsed = (performance.now() - startTime) / 1000;
    var overallRate = overallElapsed > 0 ? totalCount / overallElapsed : 0;
    var overallEta = maxEtaSeconds > 0
        ? formatTime(maxEtaSeconds)
        : (overallRate > 0 ? formatTime((totalTotal - totalCount) / overallRate) : "starting...");
    lines.push("");
    lines.push(sprintf("  TOTAL: %*d / %d (%.1f%%) | %.0f/sec | %s elapsed | ETA: %s",
        countWidth, totalCount, totalTotal,
        totalTotal > 0 ? totalCount / totalTotal * 100 : 0,
        overallRate, formatTime(overallElapsed), overallEta));

    printf("%M", lines);
}, 2000);

/* The event loop keeps running until all threads finish and close */
