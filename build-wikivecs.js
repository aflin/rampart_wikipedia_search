/*
   build-wikivecs.js — Split articles into chunks, embed each, and populate the
   wikivecs table (Vec column + a metamorph full-text index on the chunk Text).

   Usage: rampart build-wikivecs.js [lang]
   Default db: ./web_server/data/en_wikipedia_search   (lang 'en')

   Phases:
     1. Split wikitext articles into chunks, embed each, populate wikivecs table
     2. Build the likep + likev search indexes (delegated to mkvecsindex.js)

   NOTE: the standalone rampart-faiss index build has been removed. The vector
   (likev) search is served by rampart-sql's integrated vector index, built by
   mkvecsindex.js — not by a standalone .faiss file. Index building lives in
   mkvecsindex.js so it has a single owner (also runnable on its own).
*/
rampart.globalize(rampart.utils);

// modules
var Sql = require('rampart-sql');
var llamacpp = require("rampart-llamacpp");
var splitter = require(process.scriptPath + "/wikiparser/splitter.js");
var getmodel = require(process.scriptPath + "/getmodel.js");

// language code (argv[2]); default English.
var lc = (process.argv[2] && process.argv[2].length) ? process.argv[2] : "en";

// embedding model: English/Simple use the small English MiniLM; every other
// language uses multilingual bge-m3. Ensured in ~/.rampart/models/embed/ and
// symlinked into web_server/data/models/. The big multilingual model offers to
// download (prompts) when absent; MiniLM just fetches.
var embedSpec = getmodel.embedModelFor(lc);
var modelFile = getmodel.ensureModel("embed", embedSpec.name, embedSpec.url,
    process.scriptPath + "/web_server/data/models",
    { confirm: getmodel.confirmEmbedDownload(lc) });
if (!modelFile) {
    printf("No embedding model -- cannot build the semantic index for '%s'. Aborting.\n", lc);
    process.exit(1);
}

// Vector dimension is read from the model itself via modelInfo() -- a weights-free
// vocab_only load -- so the model choice above needs no other change here.
var minfo  = llamacpp.modelInfo(modelFile);
var vecDim = minfo.embedDim;

var dbpath = process.scriptPath + "/web_server/data/" + lc + "_wikipedia_search";

var sql = new Sql.init(dbpath, true);

function timeToCompletion(progress, elapsedSeconds) {
    if (progress <= 0) return "Unknown";
    if (progress >= 1) return "0m";
    var remaining = (elapsedSeconds / progress) - elapsedSeconds;
    var days  = Math.floor(remaining / 86400);
    var hours = Math.floor((remaining % 86400) / 3600);
    var min   = Math.floor((remaining % 3600) / 60);
    if (days > 0) return days + "d " + hours + "h " + min + "m";
    if (hours > 0) return hours + "h " + min + "m";
    return min + "m";
}

function elapsed(seconds) {
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);
    if (h > 0) return sprintf("%dh %dm %ds", h, m, s);
    if (m > 0) return sprintf("%dm %ds", m, s);
    return sprintf("%ds", s);
}

/* ============================================================
   Phase 1: Split + Embed → wikivecs table
   ============================================================ */

function buildVecs() {
    printf("\n=== Phase 1: Split articles and build embeddings ===\n");
    printf("Database: %s\n", dbpath);
    printf("Model: %s\n", modelFile);
    printf("  dim=%d  ctx=%d  arch=%s  pooling=%s\n", vecDim, minfo.nCtxTrain, minfo.arch, minfo.pooling);

    var emb = llamacpp.initEmbed(modelFile);
    //printf("%s\n", llamacpp.getLog());

    if(!sql.one("select * from SYSINDEX where NAME='wikitext_Id_x'")) {
        printf("Creating index on wikitext(Id)\n");
        sql.exec("create index wikitext_Id_x on wikitext(Id) WITH indexmeter 'on'");
    }

    var res = sql.one("select count(Id) cnt from wikitext");
    var totalDocs = res.cnt;
    printf("Articles in wikitext: %d\n", totalDocs);

    if(!sql.one("select * from SYSTABLES where NAME='wikivecs'")) {
        sql.query("create table wikivecs (Idsec uint64, Vec varbyte(" + vecDim + "), Title varchar(16), Text varchar(256))");
        printf("Created table wikivecs\n\n");
    }

    var docsDone = 0, secsDone = 0, skipped = 0;
    var start = new Date().getTime() / 1000;

    sql.exec("select Id, Title, Doc from wikitext", {maxRows: -1}, function(row) {
        var parts = splitter.split(row.Id, row.Title, row.Doc);
        if (!parts.length) {
            skipped++;
            docsDone++;
            return;
        }

        for (var i = 0; i < parts.length; i++) {
            var x = emb.embedTextToFp16Buf(parts[i].text);
            sql.one("insert into wikivecs values(?,?,?,?)",
                [parts[i].idSec, x.avgVec, row.Title, parts[i].text]);
            secsDone++;
        }

        docsDone++;

        if (!(docsDone % 100)) {
            var now = new Date().getTime() / 1000;
            var pct = docsDone / totalDocs;
            var eta = timeToCompletion(pct, now - start);
            printf("Docs: %d/%d (%.1f%%) | Chunks: %d | Skipped: %d | ETA: %s — %s\x1b[K\r",
                docsDone, totalDocs, 100 * pct, secsDone, skipped, eta, row.Title);
        }
        if (!(docsDone % 10000)) {
            printf("\n%s\n", dateFmt('%c %z'));
        }
    });

    var dur = new Date().getTime() / 1000 - start;
    printf("\n\nPhase 1 complete: %d docs → %d chunks (%d skipped) in %s\n",
        docsDone, secsDone, skipped, elapsed(dur));
    printf("Avg %.1f chunks/doc, %.1f docs/sec\n\n", secsDone / docsDone, docsDone / dur);

    return secsDone;
}

/* ============================================================
   Main
   ============================================================ */

printf("build-wikivecs.js\n");
printf("Started: %s\n", dateFmt('%c %z'));

var totalStart = new Date().getTime() / 1000;

// Phase 1: build wikivecs table (embeddings only; the search indexes are built
// by mkvecsindex.js, invoked at the end).
var totalVecs = 0;
if(sql.one("select * from SYSTABLES where NAME='wikivecs'")) {
    var existingVecs = sql.one("select count(Idsec) cnt from wikivecs");
    if (existingVecs && existingVecs.cnt > 0) {
        totalVecs = existingVecs.cnt;
        printf("\nwikivecs table exists with %d rows.\n", totalVecs);
        printf("  [d] Drop and rebuild from scratch\n");
        printf("  [s] Skip embedding (use the existing wikivecs table)\n");
        var rl = repl("Choice (d/s): ");
        var choice = rl.next();
        if (choice && choice.trim().toLowerCase() === 'd') {
            printf("Dropping wikivecs...\n");
            sql.query("drop table wikivecs");
            totalVecs = 0;
        } else {
            printf("Skipping Phase 1.\n\n");
        }
    }
}

if (!totalVecs) {
    totalVecs = buildVecs();
}

var totalDur = new Date().getTime() / 1000 - totalStart;
printf("=== Phase 1 complete in %s: %d chunks in %s ===\n\n", elapsed(totalDur), totalVecs, dbpath);

/* Phase 2: build the likep + likev search indexes. Delegated to mkvecsindex.js
   (the single place that owns those index builds). Close our handle first so the
   indexer's own connection has the table to itself, then run it in-process for
   live INDEXMETER progress (it reads the same lang from process.argv[2]). */
sql.close();
printf("=== Phase 2: building search indexes (mkvecsindex.js) ===\n");
require(process.scriptPath + "/mkvecsindex.js");
