/*
   build-wikivecs.js — Split articles, embed, build FAISS index.

   Usage: rampart build-wikivecs.js [dbpath]
   Default dbpath: ./web_server/data/en_wikipedia_search

   Phases:
     1. Split wikitext articles into chunks, embed each, populate wikivecs table
     2. Train FAISS index
     3. Insert vectors into FAISS index
     4. Save index and enter interactive test REPL
*/
rampart.globalize(rampart.utils);

// modules
var Sql = require('rampart-sql');
var llamacpp = require("rampart-llamacpp");
var faiss = require("rampart-faiss");
var splitter = require(process.scriptPath + "/wikiparser/splitter.js");

// variables for build
var modelFile = "all-minilm-l6-v2_f16.gguf";
var faissFactory = "IDMap2,OPQ48,IVF16384,PQ48";
var faissFile = process.scriptPath + "/wikivecs-minilm.OPQ48_IVF16384_PQ48_faiss";
var vecDim = 384;
var dbpath = process.argv[2]
                    ? 
             process.scriptPath + "/web_server/data/" + process.argv[2] + "_wikipedia_search" 
                    :
             process.scriptPath + "/web_server/data/en_wikipedia_search";

var sql = new Sql.init(dbpath, true);

var cpPrefix = faissFile + "-cp";

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

    var emb = llamacpp.initEmbed(modelFile);
    printf("%s\n", llamacpp.getLog());

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
   Checkpoint helpers (used by Phase 2 and 3)
   ============================================================ */

// Find the most recent checkpoint file and return the row offset, or 0.
function findLastCheckpoint() {
    var best = 0;
    var files = readdir(process.scriptPath);
    if (!files) return 0;
    for (var i = 0; i < files.length; i++) {
        var name = process.scriptPath + "/" +files[i];
        if (name.indexOf(cpPrefix) === 0) {
            var n = parseInt(name.substring(cpPrefix.length));
            if (n > best) best = n;
        }
    }
    return best;
}

// Remove all checkpoint files except the N most recent.
function pruneCheckpoints(keepN) {
    var files = readdir(process.scriptPath);
    if (!files) return;
    var cps = [];
    for (var i = 0; i < files.length; i++) {
        var f = process.scriptPath + "/" + files[i];
        if (f.indexOf(cpPrefix) === 0) {
            var n = parseInt(f.substring(cpPrefix.length));
            cps.push({name: f, n: n});
        }
    }
    if (cps.length <= keepN) return;
    cps.sort(function(a, b) { return b.n - a.n; }); // newest first
    for (var i = keepN; i < cps.length; i++) {
        printf("Removing old checkpoint: %s\n", cps[i].name);
        rmFile(cps[i].name);
    }
}

/* ============================================================
   Phase 2: Train FAISS index
   ============================================================ */

function trainFaiss(totalVecs) {
    printf("=== Phase 2: Train FAISS index ===\n");

    // If a checkpoint or trained index exists, skip training entirely
    var lastCp = findLastCheckpoint();
    if (lastCp > 0) {
        printf("Checkpoint found at row %d — skipping training (will resume in Phase 3)\n\n", lastCp);
        return null; // insertFaiss will load the checkpoint
    }

    var trainedFile = faissFile + "-trained";
    if (stat(trainedFile)) {
        printf("Trained index found: %s — loading it\n\n", trainedFile);
        return faiss.openIndexFromFile(trainedFile);
    }

    printf("Factory: %s (dim=%d)\n", faissFactory, vecDim);
    var idx = faiss.openFactory(faissFactory, vecDim);

    // Training needs a representative sample. Use up to 5M vectors or all if fewer.
    var trainMax = Math.min(totalVecs, 5000000);
    printf("Loading up to %d vectors for training...\n", trainMax);

    var trainer = new idx.trainer('wikivecs_train');
    var i = 0;
    var start = new Date().getTime() / 1000;

    sql.exec("select Vec from wikivecs", {maxRows: trainMax}, function(row) {
        trainer.addTrainingfp16(row.Vec);
        i++;
        if (!(i % 5000)) {
            printf("Training data: %d/%d (%.1f%%)\r", i, trainMax, 100 * i / trainMax);
        }
    });

    var loadDur = new Date().getTime() / 1000 - start;
    printf("Loaded %d training vectors in %s\n", i, elapsed(loadDur));
    printf("\nTraining index (this will take a while)...\n");
    printf("Started: %s\n", dateFmt('%c %z'));

    var trainStart = new Date().getTime() / 1000;
    trainer.train();
    var trainDur = new Date().getTime() / 1000 - trainStart;

    printf("Training complete in %s\n", elapsed(trainDur));
    printf("Finished: %s\n", dateFmt('%c %z'));

    printf("Saving trained index: %s\n\n", trainedFile);
    idx.save(trainedFile);

    return idx;
}

/* ============================================================
   Phase 3: Insert all vectors into FAISS index

   Keeps only the last 2 checkpoints to save disk space.
   If interrupted, restart and it will detect the last checkpoint,
   load it, and resume from where it left off.
   ============================================================ */

function insertFaiss(idx, totalVecs) {
    printf("=== Phase 3: Insert vectors into FAISS index ===\n");

    var startRow = findLastCheckpoint();

    if (startRow > 0) {
        var cpFile = cpPrefix + startRow;
        printf("Resuming from checkpoint: %s (row %d)\n", cpFile, startRow);
        idx = faiss.openIndexFromFile(cpFile);
    }

    var remaining = totalVecs - startRow;
    printf("Inserting %d vectors (starting at row %d of %d)\n", remaining, startRow, totalVecs);

    var i = startRow;
    var start = new Date().getTime() / 1000;
    var checkpointInterval = 2000000;

    sql.exec("select Idsec, Vec from wikivecs", {skipRows: startRow, maxRows: -1}, function(row) {
        idx.addFp16(row.Idsec, row.Vec);
        i++;
        if (!(i % 100)) {
            var now = new Date().getTime() / 1000;
            var pct = (i - startRow) / remaining;
            var eta = timeToCompletion(pct, now - start);
            printf("Inserted: %d/%d (%.1f%%) ETA: %s\r", i, totalVecs, 100 * i / totalVecs, eta);
        }
        if (!(i % checkpointInterval)) {
            var cpFile = cpPrefix + i;
            printf("\n%s: Checkpoint %s\n", dateFmt('%c %z'), cpFile);
            idx.save(cpFile);
            pruneCheckpoints(2);
        }
    });

    var dur = new Date().getTime() / 1000 - start;
    printf("\nPhase 3 complete: %d vectors inserted in %s (%.0f vec/sec)\n\n",
        i - startRow, elapsed(dur), (i - startRow) / dur);

    printf("Saving final index: %s\n", faissFile);
    idx.save(faissFile);
    printf("Done: %s\n\n", dateFmt('%c %z'));

    // Clean up all checkpoints now that we have the final index
    pruneCheckpoints(0);

    return idx;
}

/* ============================================================
   Phase 4: Verify the index with a test search
   ============================================================ */

function verifyIndex(idx) {
    printf("=== Phase 4: Verifying index ===\n");

    var emb = llamacpp.initEmbed(modelFile);

    // Use a query that should always return results from any Wikipedia corpus
    var testQuery = "the";
    printf("Test query: \"%s\"\n", testQuery);

    var x = emb.embedTextToFp16Buf(testQuery);
    var res = idx.searchFp16(x.avgVec, 5, 128);

    if (!res || !res.length) {
        fprintf(stderr, "\nERROR: FAISS search returned no results. Index may be corrupt.\n");
        fprintf(stderr, "The index file has NOT been finalized. Investigate before re-running.\n");
        process.exit(1);
    }

    printf("FAISS returned %d results:\n", res.length);
    var ids = [];
    res.forEach(function(r) { ids.push(r.id); });
    sql.exec(
        "select Idsec, Title from wikivecs where Idsec in (?)", [ids],
        function(sres) {
            printf("  %.0f — %s\n", sres.Idsec, sres.Title);
        }
    );

    printf("\nIndex verified successfully.\n\n");
}

/* ============================================================
   Phase 6: Interactive test REPL
   ============================================================ */

function testSearch(idx) {
    printf("=== Interactive search test (ctrl-c to exit) ===\n");

    var emb = llamacpp.initEmbed(modelFile);

    var rl = repl("Query: ");
    var l;
    while ((l = rl.next())) {
        var x = emb.embedTextToFp16Buf(l);
        var res = idx.searchFp16(x.avgVec, 10, 128);

        var ids = [];
        var idToScore = {};
        res.forEach(function(r) { ids.push(r.id); idToScore[r.id] = r.distance; });

        printf("\nResults:\n");
        sql.exec(
            "select vecdist(Vec, ?, 'dot', 'f16') Dist, Idsec, Title, Text " +
            "from wikivecs where Idsec in (?) order by 1 DESC",
            [x.avgVec, ids],
            function(sres, i) {
                printf("%as: %as (faiss: %.4f, dot: %.4f)\n%.100s\n\n",
                    "green", i, "green", sres.Title,
                    idToScore[sres.Idsec], sres.Dist, sres.Text);
            }
        );
        rl.refresh();
    }
}

/* ============================================================
   Main
   ============================================================ */

if(!stat(modelFile)) {
    if(modelFile == 'all-minilm-l6-v2_f16.gguf')
        fprintf(stderr, `Model 'all-minilm-l6-v2_f16.gguf' not found.  Please run:
  curl -L -o all-minilm-l6-v2_f16.gguf https://huggingface.co/LLukas22/all-MiniLM-L6-v2-GGUF/resolve/main/all-minilm-l6-v2_f16.gguf
Or choose a different model and set modelFile at the top of this script.\n`);
    else
        fprintf(stderr, `Model '%s' not found.  Check you've downloaded an appropriate model, e.g.:
 curl -L -o all-minilm-l6-v2_f16.gguf https://huggingface.co/LLukas22/all-MiniLM-L6-v2-GGUF/resolve/main/all-minilm-l6-v2_f16.gguf
Then set modelFile and vecDim at the top of this script.\n`, modelFile);
    process.exit(1);
}

var faissFileFinal = faissFile + ".complete";

printf("build-wikivecs.js\n");
printf("Started: %s\n", dateFmt('%c %z'));

// Refuse to run if a completed index already exists
if (stat(faissFileFinal)) {
    printf("\nFinal index already exists: %s\n", faissFileFinal);
    printf("Delete or move it before running this script again.\n");
    process.exit(0);
}

var totalStart = new Date().getTime() / 1000;

// Phase 1: build wikivecs table
var totalVecs = 0;
if(sql.one("select * from SYSTABLES where NAME='wikivecs'")) {
    if(!sql.one("select * from SYSINDEX where NAME='wikivecs_Idsec_x'")) {
        printf("building index on wikivecs(Idsec)\n");
        sql.exec("create index wikivecs_Idsec_x on wikivecs(Idsec) WITH indexmeter 'on'");
    }
    var existingVecs = sql.one("select count(Idsec) cnt from wikivecs");
    if (existingVecs && existingVecs.cnt > 0) {
        totalVecs = existingVecs.cnt;
        printf("\nwikivecs table exists with %d rows.\n", totalVecs);
        printf("  [d] Drop and rebuild from scratch\n");
        printf("  [s] Skip to FAISS build\n");
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

if(!sql.one("select * from SYSINDEX where NAME='wikivecs_Idsec_x'")) {
    printf("building index on wikivecs(Idsec)\n");
    sql.exec("create index wikivecs_Idsec_x on wikivecs(Idsec) WITH indexmeter 'on'");
}

// Phase 2: train (skip if checkpoint or trained index exists)
var idx = trainFaiss(totalVecs);

// Phase 3: insert into FAISS (resumes from checkpoint if available)
idx = insertFaiss(idx, totalVecs);

// Phase 4: verify the index works
verifyIndex(idx);

// Mark complete: rename to final name, clean up
rename(faissFile, faissFileFinal);
pruneCheckpoints(0);
var trainedFile = faissFile + "-trained";
if (stat(trainedFile)) {
    printf("Removing trained index: %s\n", trainedFile);
    rmFile(trainedFile);
}

// Phase 5:  full text index on wikivecs
/*
  This statement creates the full text index on the Doc field.
 
  WITH WORDEXPRESSIONS:
  see: https://docs.thunderstone.com/site/texisman/index_options.html
  and  https://docs.thunderstone.com/site/texisman/creating_a_metamorph_index.html
  see also "addexp", which is the same as "WITH WORDEXPRESSIONS" 
    but in a separate statement: https://docs.thunderstone.com/site/texisman/indexing_properties.html
  
  the regular expressions used to define a word are not perlRE.  It is thunderstone's own rex:
  https://docs.thunderstone.com/site/texisman/rex_expression_syntax.html
  
  "metamorph inverted index" can also be replaced with "FULLTEXT"
  see: https://docs.thunderstone.com/site/vortexman/create_index_with_options.html
  
  INDEXMETER prints the progress of the index creation.
  
*/

printf("Creating full text index on the vector table\n");
sql.exec(
  "create metamorph inverted index wikivecs_Text_mmix on wikivecs(Text) "+
  "WITH WORDEXPRESSIONS "+
  "('[\\alnum\\x80-\\xFF]{2,99}', '[\\alnum\\$%@\\-_\\+]{2,99}') "+
  "INDEXMETER 'on'");


var totalDur = new Date().getTime() / 1000 - totalStart;
printf("=== All phases complete in %s ===\n", elapsed(totalDur));
printf("Final index: %s\n\n", faissFileFinal);

testSearch(idx);
