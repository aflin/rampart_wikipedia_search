/*
   build-wikidocs.js — build the keyword-search table.

       wikidocs ( Id int, Title varchar(16), Doc varchar(1024) )

   Sources, in order of preference:
     1. an existing wikivecs table in the same database (identical minus
        the vector column) — copied straight across, no parsing;
     2. the wikipedia XML dump: scan (wikiparser builds an LMDB page
        index), then expand + extract across N worker threads.

   Indexes are NOT built here — run mkindex.js afterwards.

   Usage:  rampart build-wikidocs.js [lang_code] [num_threads]
*/

var Sql = require("rampart-sql");
var Lmdb = require("rampart-lmdb");
var wikilib = require(process.scriptPath + "/wikilib.js");
var thread = rampart.thread;

rampart.globalize(rampart.utils);

var formatTime = wikilib.formatTime;

var lc = "en";
if (process.argv.length > 2 && process.argv[2].length)
    lc = process.argv[2];
/* "parse": this build is CPU-bound (template expansion + inserts) and
 * never touches the GPU, so the default scales with cores. */
var nThreads = parseInt(process.argv[3]) || wikilib.defaultThreads("parse");

var FILE = process.scriptPath + "/" + lc + "wiki-latest-pages-articles.xml";
var lmdbPath = process.scriptPath + "/" + lc + "_wiki_index";
var dbPath = process.scriptPath + "/web_server/data/" + lc + "_wikipedia_search";

if (!stat(process.scriptPath + "/web_server/data"))
    mkdir(process.scriptPath + "/web_server/data");

printf("build-wikidocs.js — keyword table\nDatabase: %s\nStarted: %s\n\n",
       dbPath, dateFmt('%c %z'));

var sql = new Sql.init(dbPath, true);
if (sql.errMsg.length && !/^100/.test(sql.errMsg)) {
    fprintf(stderr, "%s\n", sql.errMsg);
    process.exit(1);
}

function getresp(def) {
    var ret = stdin.getchar(1);
    if (ret == '\n') return def;
    printf("\n");
    return ret.toLowerCase();
}

/* ---- existing wikidocs? ---- */
if (sql.one("select * from SYSTABLES where NAME='wikidocs';")) {
    var have = sql.one("select count(Id) cnt from wikidocs");
    if (have && have.cnt > 0) {
        printf("Table wikidocs already has %d rows.\n  [d] Drop and rebuild\n  [k] Keep it (exit)\n", have.cnt);
        printf("Choice (d/K): ");
        fflush(stdout);
        if (getresp("k") !== 'd') {
            printf("Keeping existing wikidocs.  Run mkindex.js if indexes are missing.\n");
            process.exit(0);
        }
    }
    printf("Dropping wikidocs...\n");
    sql.exec("drop table wikidocs;");
}

printf("Creating table wikidocs\n");
sql.exec("create table wikidocs ( Id int, Title varchar(16), Doc varchar(1024) );");

/* ================================================================
   Fast path: copy from wikivecs (same rows, minus the vector)
   ================================================================ */
var vcnt = sql.one("select * from SYSTABLES where NAME='wikivecs';") ?
           sql.one("select count(Id) cnt from wikivecs") : null;

if (vcnt && vcnt.cnt > 0) {
    printf("Found wikivecs with %d rows — copying (no dump parse needed).\n", vcnt.cnt);
    var t0 = performance.now();
    var n = 0;
    sql.exec("select Id, Title, Doc from wikivecs", { maxRows: -1 }, function (row) {
        sql.exec("insert into wikidocs values (?,?,?);", [row.Id, row.Title, row.Doc]);
        n++;
        if (!(n % 10000)) {
            var el = (performance.now() - t0) / 1000;
            printf("  %d / %d rows (%.0f/sec)  ETA: %s      \r",
                   n, vcnt.cnt, n / el, formatTime((vcnt.cnt - n) / (n / el)));
            fflush(stdout);
        }
    });
    printf("  %d rows copied in %s%30s\n\nDone.  Now run: rampart mkindex.js %s\n",
           n, formatTime((performance.now() - t0) / 1000), "", lc);
    process.exit(0);
}

/* ================================================================
   Parse path: scan the dump, then extract with N threads
   (same pipeline as the original import-multithread.js)
   ================================================================ */
if (!stat(FILE)) {
    fprintf(stderr, "Error: no wikivecs table to copy from and dump file '%s' not found.\n" +
                    "Run make-wiki-search.sh to download the dump.\n", FILE);
    process.exit(1);
}

/* ---- Step 1: LMDB page index ---- */
var wikiparser = require(process.scriptPath + "/wikiparser/wikiparser.js");
if (!stat(lmdbPath)) {
    var fileSizeMB = (stat(FILE).size / (1024 * 1024)).toFixed(0);
    printf("Step 1: Scanning %s (%s MB) to build index...\n", FILE, fileSizeMB);
    var scanEmaRate = 0, scanLastPos = 0, scanLastTime = 0;
    var scanResult = wikiparser.scan(FILE, lmdbPath, {
        progressCallback: function (p) {
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

/* ---- Step 2: collect article keys, split into per-thread key ranges ---- */
printf("Step 2: Collecting article keys...\n");

var lmdb = new Lmdb.init(lmdbPath, false, { conversion: "CBOR" });
var db = lmdb.openDb("pages");

var articleKeys = [];
var txn = new lmdb.transaction(db, false);
var row = txn.cursorGet(lmdb.op_setRange, "0:", true);
while (row && row.key && row.key.indexOf("0:") === 0) {
    var entry = CBOR.decode(row.value);
    if (!entry.redirect)
        articleKeys.push(row.key.substring(2));
    row = txn.cursorNext(true);
}
txn.abort();

var totalArticles = articleKeys.length;
printf("  %d articles found\n", totalArticles);

var ranges = [];
var keysPerThread = Math.ceil(totalArticles / nThreads);
for (var i = 0; i < nThreads; i++) {
    var startIdx = i * keysPerThread;
    if (startIdx >= totalArticles) break;
    var endIdx = Math.min(startIdx + keysPerThread, totalArticles);
    ranges.push({
        startKey: articleKeys[startIdx],
        endKey: endIdx < totalArticles ? articleKeys[endIdx] : null,
        count: endIdx - startIdx
    });
}
var numThreads = ranges.length;
articleKeys = null;

printf("  %d threads, ~%d articles each\n\n", numThreads, keysPerThread);

/* ---- Step 3: worker threads ---- */
printf("Step 3: Expanding and importing with %d threads...\n\n", numThreads);

/* globals copied into threads (set BEFORE thread creation) */
var g_FILE = FILE;
var g_lmdbPath = lmdbPath;
var g_dbPath = dbPath;
var g_wikiparserPath = process.scriptPath + "/wikiparser/wikiparser.js";

/* NOTE: main require()s the wikiparser above, before any thread exists,
 * so its C modules are already compiled and cached by the time workers
 * require it.  Keep it that way: a cmodule compile shells out to the
 * C compiler, and rampart.utils.exec() in a worker thread can hang when
 * another thread is opening a SQL connection (that path sets SIGCHLD to
 * SIG_IGN process-wide, reaping exec's child out from under its
 * read()/waitpid). */

var threads = [];
for (var i = 0; i < numThreads; i++)
    threads.push(new thread(true));

var startTime = performance.now();
var threadsFinished = 0;

function workerFunc(arg) {
    rampart.globalize(rampart.utils);

    var Sql = require("rampart-sql");
    var wp  = require(g_wikiparserPath);
    var sql = new Sql.init(g_dbPath, false);

    var myId = arg.id;
    var total = arg.count;
    var emaRate = 0, lastCount = 0, lastTime = 0;

    rampart.thread.put("progress_" + myId, {
        id: myId, count: 0, total: total, rate: 0, elapsed: 0, pct: 0
    });

    var myCount = 0;
    var myStartTime = performance.now();

    var extractOpts = {
        startKey: arg.startKey,
        progressInterval: 0,
        callback: function (title, id, text) {
            sql.exec("insert into wikidocs values (?,?,?);",
                [parseInt(id) || 0, title, text]);
            myCount++;

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
                    id: myId, count: myCount, total: total, rate: emaRate,
                    elapsed: elapsed, pct: myCount / total * 100
                });
            }
        }
    };
    if (arg.endKey) extractOpts.endKey = arg.endKey;

    var result = wp.extract(g_FILE, g_lmdbPath, extractOpts);

    var finalElapsed = (performance.now() - myStartTime) / 1000;
    rampart.thread.put("progress_" + myId, {
        id: myId, count: myCount, total: total,
        rate: myCount / finalElapsed, elapsed: finalElapsed, pct: 100, done: true
    });

    return result.articles;
}

function workerDone(count, err) {
    threadsFinished++;
    if (err) fprintf(stderr, "Thread error: %s\n", err);
}

for (var i = 0; i < numThreads; i++) {
    threads[i].exec(workerFunc, {
        id: i,
        startKey: ranges[i].startKey,
        endKey: ranges[i].endKey,
        count: ranges[i].count
    }, workerDone);
}

/* ---- progress display (%M multiline) ---- */
var progressData = [];
for (var i = 0; i < numThreads; i++)
    progressData.push({ id: i, count: 0, total: ranges[i].count, rate: 0, elapsed: 0, pct: 0 });

var pollInterval = setInterval(function () {
    if (threadsFinished >= numThreads) {
        clearInterval(pollInterval);
        var finalCount = 0;
        var finalLines = [];
        var thrWidth = String(numThreads - 1).length;
        var countWidth = String(progressData[0].total).length;
        for (var i = 0; i < numThreads; i++) {
            var p = rampart.thread.get("progress_" + i);
            if (p) { progressData[i] = p; }
            finalCount += progressData[i].count;
            var pd = progressData[i];
            finalLines.push(sprintf("  Thread %*d: %*d / %d (%5.1f%%) | %4.0f/sec DONE",
                thrWidth, i, countWidth, pd.count, pd.total, pd.count / pd.total * 100,
                pd.rate || 0));
        }
        var elapsed = (performance.now() - startTime) / 1000;
        finalLines.push("");
        finalLines.push(sprintf("  TOTAL: %*d / %d (%.1f%%) | %.0f/sec | %s elapsed",
            countWidth, finalCount, totalArticles,
            totalArticles > 0 ? finalCount / totalArticles * 100 : 0,
            finalCount / elapsed, formatTime(elapsed)));
        printf("%M", finalLines);
        if (finalCount < totalArticles)
            printf("\n\n  Done: %d of %d articles imported in %s.  %d articles could not be\n" +
                   "  processed (%.1f%% — complex templates or errors).\n",
                finalCount, totalArticles, formatTime(elapsed),
                totalArticles - finalCount, (totalArticles - finalCount) / totalArticles * 100);
        else
            printf("\n\n  Done: %d articles imported in %s (%.0f/sec across %d threads)\n",
                finalCount, formatTime(elapsed), finalCount / elapsed, numThreads);
        printf("\nNow run: rampart mkindex.js %s\n", lc);
        for (var i = 0; i < numThreads; i++) threads[i].close();
        return;
    }

    var lines = [];
    var totalCount = 0, totalTotal = 0;
    var maxEtaSeconds = 0;
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
