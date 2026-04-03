/*
    Show a single Wikipedia page, expanded and cleaned.
    Usage: rampart wikiparser/showpage.js <lang> <title> [raw]
    Example: rampart wikiparser/showpage.js fr "Éric Farro"
             rampart wikiparser/showpage.js fr "Éric Farro" raw
*/
rampart.globalize(rampart.utils);
var Lmdb = require("rampart-lmdb");
var wikiparser = require(process.scriptPath + "/wikiparser.js");

if (process.argv.length < 4) {
    fprintf(stderr, "Usage: rampart wikiparser/showpage.js <lang> <title> [raw]\n");
    fprintf(stderr, "  e.g. rampart wikiparser/showpage.js fr \"Éric Farro\"\n");
    fprintf(stderr, "       rampart wikiparser/showpage.js fr \"Éric Farro\" raw\n");
    process.exit(1);
}

var lc = process.argv[2];
var title = process.argv[3];
var raw = process.argv[4] === "raw";
var dataDir = process.scriptPath + "/..";
var dumpFile = dataDir + "/" + lc + "wiki-latest-pages-articles.xml";
var lmdbPath = dataDir + "/" + lc + "_wiki_index";

if (raw) {
    var lmdb = new Lmdb.init(lmdbPath, false, { conversion: "CBOR" });
    var db = lmdb.openDb("pages");
    var entry = lmdb.get(db, "0:" + title);
    if (entry && !entry.redirect) {
        var text = readFile(dumpFile, entry.offset, entry.length, true);
        printf("%s\n", text);
    } else {
        fprintf(stderr, "Article not found: %s\n", title);
    }
} else {
    var text = wikiparser.expandPage(dumpFile, lmdbPath, title);
    if (text && text.length > 0)
        printf("%s\n", text);
    else
        fprintf(stderr, "Article not found: %s\n", title);
}
