/*
    import.js — Scan a Wikipedia XML dump, expand templates, and import
                into a Rampart SQL full-text search database.

    Usage:  rampart import.js [lang_code]

    This replaces the old WikiExtractor.py + import pipeline with a single
    step that scans, expands, and imports directly.
*/

var Sql = require("rampart-sql");
var wikiparser = require(process.scriptPath + "/wikiparser/wikiparser.js");

rampart.globalize(rampart.utils);

function check_err() {
    if (sql.errMsg.length && !/^100/.test(sql.errMsg)) {
        console.log(sql.errMsg);
        process.exit(1);
    }
    sql.errMsg = "";
}

var lc = "en";
if (process.argv.length > 2 && process.argv[2].length)
    lc = process.argv[2];

var FILE = lc + "wiki-latest-pages-articles.xml";
var lmdbPath = "./" + lc + "_wiki_index";

if (!stat(FILE)) {
    fprintf(stderr, "Error: dump file '%s' not found\n", FILE);
    process.exit(1);
}

/* ================================================================
   Step 1: Scan the dump and build the LMDB index (if not already done)
   ================================================================ */

if (!stat(lmdbPath)) {
    var fileSizeMB = (stat(FILE).size / (1024 * 1024)).toFixed(0);
    printf("Step 1: Scanning %s (%s MB) to build index...\n", FILE, fileSizeMB);
    var scanEmaRate = 0;
    var scanLastPos = 0;
    var scanLastTime = 0;
    var scanResult = wikiparser.scan(FILE, lmdbPath, {
        progressCallback: function(p) {
            /* Exponential moving average of byte rate for smooth ETA */
            if (scanLastTime > 0) {
                var dt = p.elapsed - scanLastTime;
                var dp = p.filePos - scanLastPos;
                if (dt > 0) {
                    var instantRate = dp / dt;
                    scanEmaRate = scanEmaRate > 0
                        ? scanEmaRate * 0.95 + instantRate * 0.05
                        : instantRate;
                }
            }
            scanLastPos = p.filePos;
            scanLastTime = p.elapsed;
            var eta = (scanEmaRate > 0)
                ? formatTime((p.fileSize - p.filePos) / scanEmaRate)
                : "";
            if (eta) eta = "  ETA: " + eta;
            printf("  %d pages | %s%% | %.0f pages/sec | %s elapsed%s          \r",
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
   Step 2: Create/reset the SQL database
   ================================================================ */

if (!stat(process.scriptPath + "/web_server/data"))
    mkdir(process.scriptPath + "/web_server/data");

var sql = new Sql.init(process.scriptPath + "/web_server/data/" + lc + "_wikipedia_search", true);

if (sql.errMsg.length) {
    console.log(sql.errMsg);
    if (!/^100/.test(sql.errMsg))
        process.exit(1);
}

if (sql.one("select * from SYSTABLES where NAME='wikitext';")) {
    var resp = null;
    function getresp(def, len) {
        var l = len || 1;
        var ret = stdin.getchar(l);
        if (ret == '\n') return def;
        printf("\n");
        return ret.toLowerCase();
    }

    while (resp != 'y') {
        printf('The table "wikitext" already exists in the "./web_server/data/%s_wikipedia_search" database directory.\n   Delete it? (y/N): ', lc);
        fflush(stdout);
        resp = getresp("n");
        if (resp == 'n') {
            printf('The table "wikitext" was NOT dropped.  Cannot continue.\n');
            process.exit(1);
        }
    }

    sql.exec("drop table wikitext;");
    check_err();
}

printf("Creating table wikitext\n");
sql.exec("create table wikitext ( Id int, Title varchar(16), Doc varchar(1024) );");
check_err();

/* ================================================================
   Step 3: Extract, expand, and import articles
   ================================================================ */

printf("\nStep 3: Extracting and importing articles...\n\n");

/* Get total page count for progress reporting.
   This includes redirects, so the actual article count will be lower,
   but it's good enough for percentage estimation. */
var Lmdb = require("rampart-lmdb");
var lmdbHandle = new Lmdb.init(lmdbPath, false, { conversion: "CBOR" });
var lmdbDb = lmdbHandle.openDb("pages");
var totalPages = lmdbHandle.getCount(lmdbDb);
/* Rough estimate: ~60% are actual articles (rest are redirects + meta) */
var totalArticles = Math.floor(totalPages * 0.6);
printf("  Index has %d pages (~%d articles estimated)\n\n", totalPages, totalArticles);

function formatTime(seconds) {
    if (seconds < 60) return seconds.toFixed(0) + "s";
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    if (m < 60) return m + "m" + (s < 10 ? "0" : "") + s + "s";
    var h = Math.floor(m / 60);
    m = m % 60;
    return h + "h" + (m < 10 ? "0" : "") + m + "m";
}

var ndocs = 0;
var extractEmaRate = 0;
var extractLastCount = 0;
var extractLastTime = 0;

var result = wikiparser.extract(FILE, lmdbPath, {
    progressInterval: 500,
    callback: function(title, id, text, progress) {
        sql.exec("insert into wikitext values (?,?,?);",
            [parseInt(id) || 0, title, text]
        );
        check_err();
        ndocs++;

        if (progress) {
            /* EMA of article rate for smooth ETA */
            if (extractLastTime > 0) {
                var dt = progress.elapsed - extractLastTime;
                var dc = progress.count - extractLastCount;
                if (dt > 0) {
                    var instantRate = dc / dt;
                    extractEmaRate = extractEmaRate > 0
                        ? extractEmaRate * 0.95 + instantRate * 0.05
                        : instantRate;
                }
            }
            extractLastCount = progress.count;
            extractLastTime = progress.elapsed;

            var pct = (progress.count / totalArticles * 100).toFixed(1);
            var eta = "";
            if (extractEmaRate > 0) {
                eta = "  ETA: " + formatTime((totalArticles - progress.count) / extractEmaRate);
            }
            printf("  %d / %d (%s%%) | %.0f/sec | %s elapsed%s          \r",
                progress.count, totalArticles, pct, extractEmaRate || progress.rate,
                formatTime(progress.elapsed), eta);
            fflush(stdout);
        }
    }
});

printf("\n\n  Done: %d articles imported in %s (%.0f/sec)\n",
    result.articles, formatTime(result.elapsed), result.rate);
printf("  Skipped: %d redirects/errors\n\n", result.skipped);
