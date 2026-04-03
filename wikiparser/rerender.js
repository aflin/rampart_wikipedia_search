/*
   rerender.js — Search the database for articles matching a query,
   re-render them with the current parser, and update the database.

   Usage: rampart wikiparser/rerender.js <lang> <search_term> [max_articles]
   Example: rampart wikiparser/rerender.js en "width" 1000
            rampart wikiparser/rerender.js fr "background-color" 500
*/
rampart.globalize(rampart.utils);

var Sql = require("rampart-sql");
var wp  = require(process.scriptPath + "/wikiparser.js");

if (process.argv.length < 4) {
    fprintf(stderr, "Usage: rampart wikiparser/rerender.js <lang> <search_term> [max]\n");
    fprintf(stderr, "       rampart wikiparser/rerender.js <lang> --page <title>\n");
    fprintf(stderr, "       rampart wikiparser/rerender.js <lang> --id <id>\n");
    process.exit(1);
}

var lc       = process.argv[2];
var dataDir  = process.scriptPath + "/..";
var FILE     = dataDir + "/" + lc + "wiki-latest-pages-articles.xml";
var lmdbPath = dataDir + "/" + lc + "_wiki_index";
var dbPath   = dataDir + "/web_server/data/" + lc + "_wikipedia_search";

if (!stat(FILE)) {
    fprintf(stderr, "Error: dump file not found: %s\n", FILE);
    process.exit(1);
}

var sql = new Sql.init(dbPath, true);
var rows;

if (process.argv[3] === "--page") {
    var title = process.argv[4];
    if (!title) { fprintf(stderr, "Error: --page requires a title\n"); process.exit(1); }
    var res;
    if (stat(lmdbPath)) {
        /* Use LMDB index to get the article ID, then look up by ID */
        var Lmdb = require("rampart-lmdb");
        var lmdb = new Lmdb.init(lmdbPath, false, { conversion: "CBOR" });
        var db = lmdb.openDb("pages");
        var entry = lmdb.get(db, "0:" + title);
        if (!entry) {
            fprintf(stderr, "Article not found in LMDB index: %s\n", title);
            process.exit(1);
        }
        res = sql.exec("select Id, Title from wikitext where Id=?", [entry.id || 0], {maxRows: 1});
        if (!res.rows.length) {
            /* LMDB found it but DB doesn't have it — use LMDB id and title */
            rows = [{Id: entry.id || 0, Title: title}];
        } else {
            rows = res.rows;
        }
    } else {
        /* No LMDB index — fall back to title lookup */
        res = sql.exec("select Id, Title from wikitext where Title=?", [title], {maxRows: 1});
        if (!res.rows.length) {
            fprintf(stderr, "Article not found in database: %s\n", title);
            process.exit(1);
        }
        rows = res.rows;
    }
    printf("Re-rendering: %s (Id %d)\n", title, rows[0].Id);
} else if (process.argv[3] === "--id") {
    var id = parseInt(process.argv[4]);
    if (!id) { fprintf(stderr, "Error: --id requires a numeric id\n"); process.exit(1); }
    var res = sql.exec("select Id, Title from wikitext where Id=?", [id], {maxRows: 1});
    if (!res.rows.length) {
        fprintf(stderr, "Article not found in database with Id: %d\n", id);
        process.exit(1);
    }
    rows = res.rows;
    printf("Re-rendering: %s (Id %d)\n", rows[0].Title, id);
} else {
    var query   = process.argv[3];
    var maxRows = parseInt(process.argv[4]) || 1000;
    sql.set({likepallmatch: true, likeprows: maxRows});
    printf("Searching for '%s' (max %d)...\n", query, maxRows);
    var res = sql.exec("select Id, Title from wikitext where Doc likep ?", [query], {maxRows: maxRows});
    rows = res.rows;
    printf("Found %d articles to re-render.\n", rows.length);
}

var updated = 0, failed = 0;

for (var i = 0; i < rows.length; i++) {
    var title = rows[i].Title;
    var id    = rows[i].Id;

    try {
        var text = wp.expandPage(FILE, lmdbPath, title);
        if (text && text.length > 0) {
            sql.exec("update wikitext set Doc=? where Id=?", [text, id]);
            updated++;
        } else {
            failed++;
        }
    } catch(e) {
        failed++;
    }

    printf("  %d/%d %s\n", i + 1, res.rows.length, title);
}

printf("\nDone. Updated: %d, Failed: %d\n", updated, failed);
