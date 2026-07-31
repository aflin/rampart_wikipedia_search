/*
   build-wikivecs.js — build the fused (keyword + vector) search table.

       wikivecs ( Id int, Title varchar(16), Doc varchar(1024), Vec varvecF16 )

   Identical to wikidocs plus the multi-vector column: chunkembed() runs
   each article through the embedder's structure-aware chunker (with the
   TITLE folded into every chunk — and, for asymmetric models, the
   model's document prompt applied automatically from its .prompts.json
   sidecar) and stores ALL chunk vectors concatenated in Vec.  At search
   time "Vec likev ?" ranks each article by its best-matching chunk, and
   the keyword (likep) index lives on Doc in the SAME table.

   Sources, in order of preference:
     1. an existing wikidocs table (identical minus the vector column) —
        read straight from SQL, no parsing;
     2. the wikipedia XML dump: scan (LMDB page index), then expand +
        extract + embed across N worker threads.

   The embedding model is recorded in <dbdir>/model.json so mkindex.js
   and the search app always use the same model+engine.  Indexes are NOT
   built here — run mkindex.js afterwards.

   Usage:  rampart build-wikivecs.js [lang_code] [model_alias] [num_threads] [gguf|onnx]

     model_alias   a rampart-models catalog alias (see: rampart wikilib.js
                   menu); default picked by language.
     gguf|onnx     override the automatic engine choice (llamacpp vs onnx).
*/

var Sql = require("rampart-sql");
var wikilib = require(process.scriptPath + "/wikilib.js");
var thread = rampart.thread;

rampart.globalize(rampart.utils);

var formatTime = wikilib.formatTime;

/* after the lang code, the remaining args are recognized by shape:
 * digits = thread count, gguf|onnx = engine override, else = model alias */
var args = process.argv.slice(2);
var lc = (args[0] && args[0].length) ? args[0] : "en";
var alias = null, nThreads = 0, engOverride = null;
for (var ai = 1; ai < args.length; ai++) {
    var a = args[ai];
    if (/^\d+$/.test(a)) nThreads = parseInt(a);
    else if (a === "gguf" || a === "onnx") engOverride = a;
    else if (a.length) alias = a.toLowerCase();
}
if (!alias) alias = wikilib.defaultAlias(lc);
/* "embed": even in dump mode the model dominates, so the default is the
 * GPU-aware one (a few workers saturate CUDA/Metal). */
if (!nThreads) nThreads = wikilib.defaultThreads("embed");

var FILE = process.scriptPath + "/" + lc + "wiki-latest-pages-articles.xml";
var lmdbPath = process.scriptPath + "/" + lc + "_wiki_index";
var dataDir = process.scriptPath + "/web_server/data";
var dbPath = dataDir + "/" + lc + "_wikipedia_search";

if (!stat(dataDir)) mkdir(dataDir);

/* ---- resolve the model + engine BEFORE touching the db ---- */
var chosen = wikilib.chooseEngine(alias, engOverride);
var menuEnt = wikilib.menuEntry(alias);

printf("build-wikivecs.js — fused keyword + vector table\n");
printf("Database: %s\nModel: %s [%s] (%s)\nThreads: %d\nStarted: %s\n\n",
       dbPath, alias, chosen.engine === "gguf" ? "llamacpp" : "onnx",
       chosen.why, nThreads, dateFmt('%c %z'));

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

/* ---- existing wikivecs? ---- */
var CREATE_WIKIVECS =
    "create table wikivecs (Id int, Title varchar(16), " +
    "Doc varchar(1024), Vec varvecF16)";

var resumeMode = false;
if (!sql.one("select * from SYSTABLES where NAME='wikivecs'")) {
    sql.exec(CREATE_WIKIVECS);
    printf("Created table wikivecs\n");
} else {
    var existing = sql.one("select count(Id) cnt from wikivecs");
    if (existing && existing.cnt > 0) {
        /* a partial/complete build exists: it MUST have used the same model */
        var prev = wikilib.readModelJson(dbPath);
        if (prev && prev.alias && prev.alias !== alias) {
            printf("wikivecs was built with model '%s', but '%s' was requested.\n" +
                   "Vectors from different models cannot mix.\n" +
                   "  [d] Drop wikivecs and rebuild with %s\n  [s] Stop (exit)\n",
                   prev.alias, alias, alias);
            printf("Choice (d/S): ");
            fflush(stdout);
            if (getresp("s") !== 'd') { printf("Exiting.\n"); process.exit(0); }
            printf("Dropping wikivecs...\n");
            sql.exec("drop table wikivecs");
            sql.exec(CREATE_WIKIVECS);
        } else {
            printf("wikivecs already has %d rows.\n", existing.cnt);
            printf("  [r] Resume (skip already-embedded articles)\n");
            printf("  [d] Drop and rebuild from scratch\n");
            printf("  [s] Skip (exit)\n");
            printf("Choice (r/d/S): ");
            fflush(stdout);
            var resp = getresp("s");
            if (resp === 'd') {
                printf("Dropping wikivecs...\n");
                sql.exec("drop table wikivecs");
                sql.exec(CREATE_WIKIVECS);
            } else if (resp === 'r') {
                resumeMode = true;
                printf("Resuming: existing articles will be skipped.\n");
            } else {
                printf("Keeping existing wikivecs. Exiting.\n");
                process.exit(0);
            }
        }
    }
}

/* ---- materialize the model in the shared ~/.rampart store ---- */
var minfo = wikilib.ensureEmbedModel(alias, chosen.engine);
printf("Model file: %s\n", minfo.path);

/* Load the embed model once HERE in main, before any worker starts, so
 * every worker's sql.set is a handle-cache hit.  gguf: workers get their
 * own llama_context over the shared weights (llamaEmbedPerThread).
 * onnx: one session, concurrent Run per worker. */
printf("Loading embed model...\n");
if (chosen.engine === "gguf") sql.set({ llamaEmbed: minfo.path });
else                          sql.set({ onnxEmbed: { model: minfo.path } });

/* Per-vector dimension, read from the model itself: mkindex.js needs it
 * for the vector-index statement (a chunked column can't infer it). */
var vecDim = sql.one("select embed(?) v", ["dimension probe"]).v.dim;
printf("Model dim: %d\n\n", vecDim);

/* model.json records the ALIAS only; the path is re-resolved from it
 * through rampart-models (~/.rampart store) at serve time, so the db is
 * portable and never depends on a web_server/data/models symlink. */
wikilib.writeModelJson(dbPath, {
    alias: alias,
    engine: chosen.engine,
    dim: vecDim,
    multilingual: menuEnt ? menuEnt.multilingual : null,
    created: dateFmt('%Y-%m-%d %H:%M:%S %z')
});

/* Resume needs a fast per-Id existence check: a plain btree on
 * wikivecs(Id).  Cheap on a partial table, useful afterwards anyway. */
if (resumeMode && !sql.one("select * from SYSINDEX where NAME='wikivecs_Id_x'")) {
    printf("Creating resume index on wikivecs(Id)...\n");
    sql.exec("create index wikivecs_Id_x on wikivecs(Id);");
}

/* ================================================================
   Pick the source: wikidocs (SQL copy+embed) or the XML dump
   ================================================================ */
var srcMode = null, totalArticles = 0, ranges = [];

var dcnt = sql.one("select * from SYSTABLES where NAME='wikidocs'") ?
           sql.one("select count(Id) cnt from wikidocs") : null;

if (dcnt && dcnt.cnt > 0) {
    srcMode = "sql";
    totalArticles = dcnt.cnt;
    printf("Source: existing wikidocs table (%d articles — no dump parse needed)\n", totalArticles);
    var rowsPerThread = Math.ceil(totalArticles / nThreads);
    for (var i = 0; i < nThreads; i++) {
        var skip = i * rowsPerThread;
        if (skip >= totalArticles) break;
        ranges.push({ skip: skip, max: Math.min(rowsPerThread, totalArticles - skip) });
    }
} else {
    srcMode = "dump";
    if (!stat(FILE)) {
        fprintf(stderr, "Error: no wikidocs table to read from and dump file '%s' not found.\n" +
                        "Run make-wiki-search.sh to download the dump.\n", FILE);
        process.exit(1);
    }

    /* ---- scan: LMDB page index (identical to build-wikidocs.js) ---- */
    var wikiparser = require(process.scriptPath + "/wikiparser/wikiparser.js");
    if (!stat(lmdbPath)) {
        var fileSizeMB = (stat(FILE).size / (1024 * 1024)).toFixed(0);
        printf("Scanning %s (%s MB) to build the page index...\n", FILE, fileSizeMB);
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
        printf("  %d pages indexed in %s                                    \n\n",
            scanResult.pages, formatTime(scanResult.elapsed));
    } else {
        printf("Page index already exists at %s (skipping scan)\n\n", lmdbPath);
    }

    /* ---- collect keys, build per-thread key ranges ---- */
    var Lmdb = require("rampart-lmdb");
    var lmdb = new Lmdb.init(lmdbPath, false, { conversion: "CBOR" });
    var ldb = lmdb.openDb("pages");
    var articleKeys = [];
    var txn = new lmdb.transaction(ldb, false);
    var row = txn.cursorGet(lmdb.op_setRange, "0:", true);
    while (row && row.key && row.key.indexOf("0:") === 0) {
        var entry = CBOR.decode(row.value);
        if (!entry.redirect)
            articleKeys.push(row.key.substring(2));
        row = txn.cursorNext(true);
    }
    txn.abort();
    totalArticles = articleKeys.length;
    printf("Source: %s (%d articles)\n", FILE.split("/").pop(), totalArticles);

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
    articleKeys = null;
}

var numThreads = ranges.length;
printf("%d threads, ~%d articles each\n\n", numThreads, Math.ceil(totalArticles / numThreads));

/* ================================================================
   Worker threads
   ================================================================ */

/* globals copied into threads (set BEFORE thread creation) */
var g_dbPath = dbPath;
var g_engine = chosen.engine;
var g_modelPath = minfo.path;
var g_FILE = FILE;
var g_lmdbPath = lmdbPath;
var g_wikiparserPath = process.scriptPath + "/wikiparser/wikiparser.js";

/* NOTE: in dump mode main require()s the wikiparser above, before any
 * thread exists, so its C modules are compiled and cached by the time
 * workers require it.  Keep it that way: a cmodule compile shells out to
 * the C compiler, and rampart.utils.exec() in a worker thread can hang
 * when another thread is opening a SQL connection (that path sets
 * SIGCHLD to SIG_IGN process-wide, reaping exec's child out from under
 * its read()/waitpid). */

var threads = [];
for (var i = 0; i < numThreads; i++)
    threads.push(new thread(true));

var startTime = performance.now();
var threadsFinished = 0;

/*
   Worker: embed + insert one slice of articles.  arg.mode selects the
   source ("sql" range of wikidocs rows, or "dump" key range).  Every
   article goes through chunkembed(Doc, '', Title): the embedder chunks
   the article and embeds each chunk as title + chunk (plus the model's
   document prompt when it has one).
*/
function workerFunc(arg) {
    rampart.globalize(rampart.utils);

    var Sql = require("rampart-sql");
    var sql = new Sql.init(g_dbPath, false);
    if (g_engine === "gguf") sql.set({ llamaEmbed: g_modelPath });
    else                     sql.set({ onnxEmbed: { model: g_modelPath } });
    var wp = (arg.mode === "dump") ? require(g_wikiparserPath) : null;

    var myId = arg.id;
    var myCount = 0, myEmpty = 0, myFailed = 0, mySkipped = 0, myRepaired = 0;
    var emaRate = 0, lastCount = 0, lastTime = 0;
    var myStartTime = performance.now();

    rampart.thread.put("progress_" + myId, {
        id: myId, docs: 0, empty: 0, failed: 0, total: arg.total,
        rate: 0, elapsed: 0, pct: 0
    });

    function report() {
        var elapsed = (performance.now() - myStartTime) / 1000;
        /* rate over >=2s windows (per-doc reciprocals bias the EMA high) */
        if (lastTime === 0) {
            lastTime = elapsed;
            lastCount = myCount;
        } else if (elapsed - lastTime >= 2) {
            var ir = (myCount - lastCount) / (elapsed - lastTime);
            emaRate = emaRate > 0 ? emaRate * 0.7 + ir * 0.3 : ir;
            lastCount = myCount;
            lastTime = elapsed;
        }
        rampart.thread.put("progress_" + myId, {
            id: myId, docs: myCount, empty: myEmpty, failed: myFailed,
            skipped: mySkipped, repaired: myRepaired, total: arg.total,
            rate: emaRate, elapsed: elapsed, pct: myCount / arg.total * 100
        });
    }

    function insertArticle(id, title, doc) {
        var existing = arg.resume ?
            sql.one("select Vec from wikivecs where Id = ?", [id]) : null;
        if (existing && existing.Vec) {
            mySkipped++;
        } else if (existing) {
            /* row exists but has NO vector — a prior run's embed failure
             * fell back to a null-vec insert.  Repair it. */
            try {
                sql.one("update wikivecs set Vec = chunkembed(?, '', ?) where Id = ?",
                        [doc, title, id]);
                myRepaired++;
            } catch (e) { myFailed++; }
        } else if (!doc || !doc.length) {
            /* keep the row for keyword completeness; Vec stays null so
             * likev just never ranks it */
            try {
                sql.one("insert into wikivecs values(?,?,?,?)", [id, title, doc || "", null]);
            } catch (e) { myFailed++; }
            myEmpty++;
        } else {
            try {
                sql.one("insert into wikivecs values(?,?,?,chunkembed(?, '', ?))",
                        [id, title, doc, doc, title]);
            } catch (e) {
                /* embed failure: keep the article, without a vector */
                myFailed++;
                try {
                    sql.one("insert into wikivecs values(?,?,?,?)", [id, title, doc, null]);
                } catch (e2) {}
            }
        }
        myCount++;
        report();   /* every doc: embedding takes seconds, put() microseconds */
    }

    if (arg.mode === "sql") {
        sql.exec("select Id, Title, Doc from wikidocs",
            { skipRows: arg.skip, maxRows: arg.max },
            function (row) { insertArticle(row.Id, row.Title, row.Doc); });
    } else {
        /* wp was loaded in the serialized prologue above */
        var extractOpts = {
            startKey: arg.startKey,
            progressInterval: 0,
            callback: function (title, id, text) {
                insertArticle(parseInt(id) || 0, title, text);
            }
        };
        if (arg.endKey) extractOpts.endKey = arg.endKey;
        wp.extract(g_FILE, g_lmdbPath, extractOpts);
    }

    var finalElapsed = (performance.now() - myStartTime) / 1000;
    rampart.thread.put("progress_" + myId, {
        id: myId, docs: myCount, empty: myEmpty, failed: myFailed,
        skipped: mySkipped, repaired: myRepaired, total: arg.total,
        rate: myCount / finalElapsed, elapsed: finalElapsed, pct: 100, done: true
    });

    return { docs: myCount, empty: myEmpty, failed: myFailed,
             skipped: mySkipped, repaired: myRepaired };
}

function workerDone(result, err) {
    threadsFinished++;
    if (err) fprintf(stderr, "Thread error: %s\n", err);
}

for (var i = 0; i < numThreads; i++) {
    var arg = {
        id: i,
        mode: srcMode,
        resume: resumeMode,
        total: srcMode === "sql" ? ranges[i].max : ranges[i].count
    };
    if (srcMode === "sql") {
        arg.skip = ranges[i].skip;
        arg.max = ranges[i].max;
    } else {
        arg.startKey = ranges[i].startKey;
        arg.endKey = ranges[i].endKey;
    }
    threads[i].exec(workerFunc, arg, workerDone);
}

/* ================================================================
   Progress display (%M multiline)
   ================================================================ */

/* big articles embed in seconds-per-doc, not docs-per-second; keep the
 * rate readable either way */
function fmtRate(r) {
    if (r >= 1 || r <= 0) return sprintf("%4.1f/sec", r);
    return sprintf("%4.1f/min", r * 60);
}

var progressData = [];
for (var i = 0; i < numThreads; i++)
    progressData.push({ id: i, docs: 0, empty: 0, failed: 0,
                        total: srcMode === "sql" ? ranges[i].max : ranges[i].count,
                        rate: 0, elapsed: 0, pct: 0 });

var pollInterval = setInterval(function () {
    if (threadsFinished >= numThreads) {
        clearInterval(pollInterval);

        var totalDocs = 0, totalEmpty = 0, totalFailed = 0, totalSkipped = 0, totalRepaired = 0;
        var finalLines = [];
        var thrWidth = String(numThreads - 1).length;
        var countWidth = String(progressData[0].total).length;

        for (var i = 0; i < numThreads; i++) {
            var p = rampart.thread.get("progress_" + i);
            if (p) progressData[i] = p;
            var pd = progressData[i];
            totalDocs += pd.docs;
            totalEmpty += pd.empty;
            totalFailed += pd.failed;
            totalSkipped += (pd.skipped || 0);
            totalRepaired += (pd.repaired || 0);
            finalLines.push(sprintf("  Thread %*d: %*d / %d docs | %s DONE",
                thrWidth, i, countWidth, pd.docs, pd.total, fmtRate(pd.rate || 0)));
        }

        var elapsed = (performance.now() - startTime) / 1000;
        finalLines.push("");
        finalLines.push(sprintf("  TOTAL: %d / %d docs | %d resumed-skips | %d repaired | %d empty | %d embed-failures | %s | %s",
            totalDocs, totalArticles, totalSkipped, totalRepaired, totalEmpty, totalFailed,
            fmtRate(totalDocs / elapsed), formatTime(elapsed)));
        printf("%M", finalLines);

        printf("\n\nDone: %d articles into wikivecs in %s (%s across %d threads)\n",
            totalDocs, formatTime(elapsed), fmtRate(totalDocs / elapsed), numThreads);
        printf("Finished: %s\n\nNow run: rampart mkindex.js %s\n", dateFmt('%c %z'), lc);

        for (var i = 0; i < numThreads; i++) threads[i].close();
        return;
    }

    var lines = [];
    var totalDocs = 0, totalTotal = 0;
    var sumRate = 0;          /* sum of live per-thread EMA rates = CURRENT throughput */
    var remActive = 0;        /* remaining docs on still-active threads */
    var cumRateActive = 0;    /* sum of their CUMULATIVE (docs/elapsed) rates */
    var thrWidth = String(numThreads - 1).length;
    var countWidth = String(progressData[0].total).length;

    for (var i = 0; i < numThreads; i++) {
        var p = rampart.thread.get("progress_" + i);
        if (p) progressData[i] = p;
        var pd = progressData[i];
        totalDocs += pd.docs;
        totalTotal += pd.total;
        if (!pd.done) sumRate += (pd.rate || 0);

        /* ETAs come from CUMULATIVE rates, not the windowed EMA: article
         * length varies wildly, so the EMA swings the estimate by hours
         * (replaying a 4h45m qwen3 build: slowest-thread-by-EMA averaged
         * 99% error mid-run; cumulative-rate estimates 25%, converging
         * smoothly).  The EMA is still shown as the live rate. */
        var eta = "", cumRate = 0;
        if (!pd.done && pd.docs > 0 && pd.elapsed > 0) {
            cumRate = pd.docs / pd.elapsed;
            remActive += pd.total - pd.docs;
            cumRateActive += cumRate;
            if (pd.pct < 100)
                eta = "  ETA: " + formatTime((pd.total - pd.docs) / cumRate);
        }
        var status = pd.done ? " DONE" : "";
        lines.push(sprintf("  Thread %*d: %*d / %d docs | %s%s%s",
            thrWidth, i, countWidth, pd.docs, pd.total,
            fmtRate(pd.rate || 0), eta, status));
    }

    /* sumRate = what the build is doing NOW; the cumulative average
     * includes model load and slow starts, so it's shown as `avg`.
     * Overall ETA: remaining docs on active threads / their summed
     * cumulative rates — equals the plain remaining/avg mid-run, and
     * stays honest when the pool drains to one slow tail thread.  Early
     * numbers are noise (the corpus itself speeds up/slows down), so the
     * first two minutes just say "warming up". */
    var overallElapsed = (performance.now() - startTime) / 1000;
    var avgRate = overallElapsed > 0 ? totalDocs / overallElapsed : 0;
    var overallEta;
    if (overallElapsed < 120 || totalDocs < totalTotal * 0.005)
        overallEta = "warming up...";
    else if (cumRateActive > 0)
        overallEta = formatTime(remActive / cumRateActive);
    else
        overallEta = "starting...";
    lines.push("");
    lines.push(sprintf("  TOTAL: %*d / %d docs | %s now | %s avg | %s elapsed | ETA: %s",
        countWidth, totalDocs, totalArticles,
        fmtRate(sumRate), fmtRate(avgRate), formatTime(overallElapsed), overallEta));

    printf("%M", lines);
}, 2000);
