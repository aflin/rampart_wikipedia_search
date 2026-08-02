/*
   mkindex.js — build ALL search indexes for a language database.

   For each table that exists (wikidocs and/or wikivecs):
     - a regular (btree) index on Id
     - the full-text metamorph inverted index on Doc

   For wikivecs additionally:
     - the vector (likev) index on Vec.  IVFPQ by default (the right
       backend at wikipedia scale); a small corpus (too few chunk
       vectors to train IVFPQ) falls back to HNSW.  The per-vector
       dimension comes from model.json (a chunked column stores k x dim
       cells, so the dim can't be inferred from rows).

   An index that already exists is skipped, as is a table that doesn't —
   safe to re-run any time (e.g. after resuming an interrupted build).

   Usage:  rampart mkindex.js [lang_code]

   Notes on the metamorph index options:
     The default word expression ([\uword]{2,99}: Unicode letters,
     digits and combining marks, matched as whole utf-8 characters)
     handles every script, so no WITH WORDEXPRESSIONS override is
     needed; INDEXMETER 'on' prints creation progress.
*/

rampart.globalize(rampart.utils);

var Sql = require("rampart-sql");
var wikilib = require(process.scriptPath + "/wikilib.js");

var lc = "en";
if (process.argv.length > 2 && process.argv[2].length)
    lc = process.argv[2];

var dbPath = process.scriptPath + "/web_server/data/" + lc + "_wikipedia_search";

if (!stat(dbPath)) {
    fprintf(stderr, "No database at %s — run a build first.\n", dbPath);
    process.exit(1);
}

var sql = new Sql.init(dbPath);

/* index memory: 80% of system memory.  A single-pass text index build on
 * full English wikipedia wants ~35-40GB; below the limit texis inserts
 * merge steps automatically. */
sql.set({ indexMem: 80 });

function tableExists(t) {
    return !!sql.one("select * from SYSTABLES where NAME=?", [t]);
}
function indexExists(x) {
    return !!sql.one("select * from SYSINDEX where NAME=?", [x]);
}

/* Word expressions are stored in the index and applied to query terms
   at search time, so tokenization lives entirely here.

   The default word expression ([\uword]{2,99}: Unicode letters,
   digits and combining marks, matched as whole utf-8 characters)
   breaks words correctly at ZWNJ, punctuation and all other non-word
   codepoints in any script, so no WORDEXPRESSIONS override is
   needed. */
var MM_OPTS = "WITH INDEXMETER 'on'";

var did = 0, skipped = 0;

function makeIndex(name, stmt, what) {
    if (indexExists(name)) {
        printf("  %s already exists, skipping\n", name);
        skipped++;
        return;
    }
    printf("  creating %s (%s)\n", name, what);
    sql.exec(stmt);
    did++;
}

["wikidocs", "wikivecs"].forEach(function (t) {
    if (!tableExists(t)) {
        printf("table %s: not present, skipping\n", t);
        return;
    }
    printf("table %s:\n", t);

    makeIndex(t + "_Id_x",
        "create index " + t + "_Id_x on " + t + "(Id);",
        "btree on Id");

    makeIndex(t + "_Doc_mmix",
        "create metamorph inverted index " + t + "_Doc_mmix on " + t + "(Doc) " + MM_OPTS + ";",
        "full-text on Doc");

    if (t === "wikivecs" && !indexExists("wikivecs_Vec_vx")) {
        var minfo = wikilib.readModelJson(dbPath);
        if (!minfo || !minfo.dim) {
            fprintf(stderr, "  cannot create the vector index: %s/model.json is missing or has no dim\n" +
                            "  (build-wikivecs.js writes it — re-run the vector build)\n", dbPath);
            process.exit(1);
        }
        /* IVFPQ needs enough chunk vectors to train its codebooks; a
         * small corpus gets HNSW instead. */
        var cnt = sql.one("select count(Id) cnt from wikivecs");
        var backend = (cnt && cnt.cnt < 2000) ? " backend 'hnsw'" : "";
        if (backend.length)
            printf("  (%d rows: too few vectors to train IVFPQ — using HNSW)\n", cnt.cnt);
        makeIndex("wikivecs_Vec_vx",
            "create vector index wikivecs_Vec_vx on wikivecs(Vec) " +
            "WITH" + backend + " INDEXMETER 'on' vec_dim " + minfo.dim + ";",
            "vector on Vec, dim " + minfo.dim + (backend.length ? ", hnsw" : ", ivfpq"));
    } else if (t === "wikivecs") {
        printf("  wikivecs_Vec_vx already exists, skipping\n");
        skipped++;
    }
});

printf("\nmkindex done: %d created, %d already present.\n", did, skipped);
