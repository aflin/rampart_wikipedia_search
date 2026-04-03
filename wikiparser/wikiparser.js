/*
    wikiparser module — Parse and extract text from Wikipedia XML dumps.

    Usage:
        var wikiparser = require("./wikiparser");

        // Step 1: Build index (one-time)
        wikiparser.scan(dumpFile, lmdbPath, {limit: N});

        // Step 2: Extract articles
        wikiparser.extract(dumpFile, lmdbPath, {
            callback: function(title, id, text, progress) { ... },
            limit: 100,
            startKey: "A",          // start from this title prefix
            endKey: "B",            // stop at this title prefix
            progressInterval: 1000, // call with progress info every N docs (0 to disable)
        });

        // Step 3: Extract a single article
        var text = wikiparser.expandPage(dumpFile, lmdbPath, "Article Title");
*/

var Sql     = require("rampart-sql");
var Lmdb    = require("rampart-lmdb");
var cmodule = require("rampart-cmodule.js");
rampart.globalize(rampart.utils);

/* module.path is the directory of this module file (set by rampart's require) */
var modulePath = module.path + "/";

/* ================================================================
   C module: XML dump scanner
   ================================================================ */

var scanSupportFuncs = `

#define BUFSZ       (1024 * 256)
#define MAX_TITLE   (4096)
#define MAX_NS      (32)

enum {
    S_OUTSIDE,
    S_IN_PAGE,
    S_IN_TEXT,
    S_PAST_TEXT
};

static int extract_tag_content(const char *p, char *out, int maxlen)
{
    while (*p && *p != '>') p++;
    if (!*p) return 0;
    p++;
    int i = 0;
    while (*p && *p != '<' && i < maxlen - 1) {
        out[i++] = *p++;
    }
    out[i] = '\\0';
    return i;
}

static inline int match_at(const char *buf, const char *str, int len)
{
    return memcmp(buf, str, len) == 0;
}
`;

var scanExportFunc = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
{
    const char *filename = REQUIRE_STRING(ctx, 0,
        "scanWikiDump: first argument must be a filename string");
    REQUIRE_FUNCTION(ctx, 1,
        "scanWikiDump: second argument must be a callback function");
    int64_t max_pages = 0;
    if (duk_is_number(ctx, 2))
        max_pages = (int64_t)duk_get_number(ctx, 2);

    FILE *fp = fopen(filename, "rb");
    if (!fp)
        RP_THROW(ctx, "scanWikiDump: cannot open file '%s'", filename);

    char *buf = (char *)malloc(BUFSZ + 1);
    if (!buf) { fclose(fp); RP_THROW(ctx, "scanWikiDump: out of memory"); }

    int    state = S_OUTSIDE;
    char   title[MAX_TITLE];
    char   ns[MAX_NS];
    char   page_id[MAX_NS];
    int    has_title = 0, has_ns = 0, has_id = 0;
    int    is_redirect = 0;
    int64_t text_offset = 0;
    int64_t page_count  = 0;
    int64_t file_pos = 0;

    while (fgets(buf, BUFSZ, fp)) {
        int line_len = (int)strlen(buf);
        char *p = buf;
        while (*p == ' ' || *p == '\\t') p++;

        switch (state) {
        case S_OUTSIDE:
            if (match_at(p, "<page>", 6) || match_at(p, "<page ", 6)) {
                state = S_IN_PAGE;
                has_title = 0; has_ns = 0; has_id = 0; is_redirect = 0;
                title[0] = '\\0'; ns[0] = '\\0'; page_id[0] = '\\0';
            }
            break;
        case S_IN_PAGE:
            if (match_at(p, "<title>", 7)) {
                has_title = extract_tag_content(p + 6, title, MAX_TITLE);
            } else if (match_at(p, "<id>", 4) && !has_id) {
                has_id = extract_tag_content(p + 3, page_id, MAX_NS);
            } else if (match_at(p, "<ns>", 4)) {
                has_ns = extract_tag_content(p + 3, ns, MAX_NS);
            } else if (match_at(p, "<redirect", 9)) {
                is_redirect = 1;
            } else if (match_at(p, "<text", 5)) {
                char *gt = strchr(p + 5, '>');
                if (gt) {
                    text_offset = file_pos + (int64_t)(gt + 1 - buf);
                    if (gt > p && *(gt - 1) == '/') {
                        text_offset = 0;
                        state = S_PAST_TEXT;
                    } else if (strstr(gt + 1, "</text>")) {
                        char *end = strstr(gt + 1, "</text>");
                        int64_t text_end = file_pos + (int64_t)(end - buf);
                        int64_t text_len = text_end - text_offset;
                        if (has_title && has_ns) {
                            duk_dup(ctx, 1);
                            duk_push_string(ctx, ns);
                            duk_push_string(ctx, title);
                            duk_push_number(ctx, (double)text_offset);
                            duk_push_number(ctx, (double)text_len);
                            duk_push_int(ctx, is_redirect);
                            duk_push_number(ctx, (double)file_pos);
                            duk_push_string(ctx, page_id);
                            duk_call(ctx, 7);
                            duk_pop(ctx);
                            page_count++;
                            if (max_pages > 0 && page_count >= max_pages) goto done;
                        }
                        state = S_PAST_TEXT;
                    } else {
                        state = S_IN_TEXT;
                    }
                }
            } else if (match_at(p, "</page>", 7)) {
                state = S_OUTSIDE;
            }
            break;
        case S_IN_TEXT:
            {
                char *end = strstr(p, "</text>");
                if (end) {
                    int64_t text_end = file_pos + (int64_t)(end - buf);
                    int64_t text_len = text_end - text_offset;
                    if (has_title && has_ns) {
                        duk_dup(ctx, 1);
                        duk_push_string(ctx, ns);
                        duk_push_string(ctx, title);
                        duk_push_number(ctx, (double)text_offset);
                        duk_push_number(ctx, (double)text_len);
                        duk_push_int(ctx, is_redirect);
                        duk_push_number(ctx, (double)file_pos);
                        duk_push_string(ctx, page_id);
                        duk_call(ctx, 7);
                        duk_pop(ctx);
                        page_count++;
                        if (max_pages > 0 && page_count >= max_pages) goto done;
                    }
                    state = S_PAST_TEXT;
                }
            }
            break;
        case S_PAST_TEXT:
            if (match_at(p, "</page>", 7)) state = S_OUTSIDE;
            break;
        }
        file_pos += (int64_t)line_len;
    }
done:
    free(buf);
    fclose(fp);
    duk_push_number(ctx, (double)page_count);
    return 1;
}
`;

/* ================================================================
   C module: template expansion + cleanup engine
   ================================================================ */

var expandSupportCode = readFile(modulePath + "/expand-engine.c", true);

var expandExportFunc = `
#include <string.h>
{
    duk_size_t text_len;
    const char *text = REQUIRE_LSTRING(ctx, 0, &text_len,
        "wikiExpandC: arg 1 must be a string (wikitext)");
    REQUIRE_FUNCTION(ctx, 1,
        "wikiExpandC: arg 2 must be a function (template lookup callback)");
    REQUIRE_OBJECT(ctx, 2,
        "wikiExpandC: arg 3 must be an object (magic words)");
    REQUIRE_OBJECT(ctx, 3,
        "wikiExpandC: arg 4 must be an object (config)");

    int do_cleanup = 0;
    if (duk_is_boolean(ctx, 4))
        do_cleanup = duk_get_boolean(ctx, 4);

    expand_ctx ec;
    memset(&ec, 0, sizeof(ec));
    ec.ctx = ctx;
    ec.lookup_fn_idx = 1;
    ec.max_depth = MAX_DEPTH;
    ec.max_calls = MAX_CALLS;
    ec.max_ms = 10000;
    ec.call_count = 0;
    ec.start_time = (double)clock() / CLOCKS_PER_SEC * 1000.0;

    load_magic_words(&ec, ctx, 2);
    ht_init(&ec.tpl_cache);
    ec.tpl_ns[0] = '\\0';
    ec.tpl_ns_len = 0;

    duk_get_prop_string(ctx, 3, "templateNamespace");
    if (duk_is_string(ctx, -1)) {
        duk_size_t nslen;
        const char *ns = duk_get_lstring(ctx, -1, &nslen);
        if (nslen < sizeof(ec.tpl_ns)) {
            memcpy(ec.tpl_ns, ns, nslen);
            ec.tpl_ns[nslen] = '\\0';
            ec.tpl_ns_len = (int)nslen;
        }
    }
    duk_pop(ctx);

    duk_get_prop_string(ctx, 3, "maxDepth");
    if (duk_is_number(ctx, -1)) ec.max_depth = duk_get_int(ctx, -1);
    duk_pop(ctx);

    duk_get_prop_string(ctx, 3, "maxCalls");
    if (duk_is_number(ctx, -1)) ec.max_calls = duk_get_int(ctx, -1);
    duk_pop(ctx);

    /* Pass 1: Template expansion (output has \\x01/\\x02 sentinels) */
    rp_string *expanded = rp_string_new(text_len + 1024);
    wiki_expand(&ec, text, (int)text_len, 0, expanded);

    if (do_cleanup) {
        DBG_TABLE_BALANCE("EXPANDED", expanded->str, (int)expanded->len);
        /* Pass 1.5: Flatten sentinels, build origin map */
        rp_string *flat = rp_string_new(expanded->len + 64);
        origin_map *origins = origin_map_new((int)expanded->len);
        flatten_sentinels(expanded->str, (int)expanded->len, flat, origins);
        rp_string_free(expanded);

        DBG_TABLE_BALANCE("FLAT", flat->str, (int)flat->len);
        /* Pass 2: Strip wiki markup on flat text */
        origin_map *origins2 = origin_map_new((int)flat->len);
        rp_string *stripped = rp_string_new(flat->len + 256);
        strip_wiki_markup(flat->str, (int)flat->len, stripped,
                           origins, origins2, 0, 0);
        origin_map_free(origins);
        rp_string_free(flat);

        DBG_TABLE_BALANCE("STRIPPED", stripped->str, (int)stripped->len);
        /* Pass 2.5: Filter debris using origin map */
        rp_string *filtered = rp_string_new(stripped->len + 64);
        filter_debris(stripped->str, (int)stripped->len, filtered, origins2);
        rp_string_free(stripped);
        DBG_TABLE_BALANCE("FILTERED", filtered->str, (int)filtered->len);
        /* Pass 3: Cleanup (HTML, tables, formatting, entities) */
        rp_string *cleaned = rp_string_new(filtered->len + 256);
        cleanup_expanded_text(filtered->str, (int)filtered->len, cleaned, origins2);
        origin_map_free(origins2);
        rp_string_free(filtered);

        duk_push_lstring(ctx, cleaned->str, cleaned->len);
        rp_string_free(cleaned);
    } else {
        duk_push_lstring(ctx, expanded->str, expanded->len);
        rp_string_free(expanded);
    }

    ht_free(&ec.magic);
    ht_free(&ec.tpl_cache);
    return 1;
}
`;

/* ================================================================
   Compile C modules
   ================================================================ */

var scanWikiDump, wikiExpandC;

try {
    scanWikiDump = cmodule("wikiDumpScanner", scanExportFunc, scanSupportFuncs, "-O3");
} catch(e) {
    throw new Error("wikiparser: failed to compile scanner: " + (e.message || e));
}

try {
    wikiExpandC = cmodule("wikiTemplateExpander", expandExportFunc, expandSupportCode, "-O3 -std=c99", "-lm");
} catch(e) {
    throw new Error("wikiparser: failed to compile expansion engine: " + (e.message || e));
}

/* ================================================================
   Siteinfo parsing
   ================================================================ */

function extractTagContent(s) {
    var gt = s.indexOf(">");
    if (gt < 0) return "";
    var lt = s.indexOf("<", gt + 1);
    if (lt < 0) return s.substring(gt + 1);
    return s.substring(gt + 1, lt);
}

function extractAttr(s, name) {
    var pat = name + '="';
    var idx = s.indexOf(pat);
    if (idx < 0) return "";
    var start = idx + pat.length;
    var end = s.indexOf('"', start);
    if (end < 0) return "";
    return s.substring(start, end);
}

function parseSiteinfo(filename) {
    var rl = readLine(filename);
    var line;
    var siteinfo = {
        namespaces: {},
        urlbase: "",
        sitename: "",
        dbname: ""
    };
    var inSiteinfo = false;

    while ((line = rl.next())) {
        var trimmed = trim(line);
        if (trimmed === "<siteinfo>" || trimmed === "<siteinfo >") {
            inSiteinfo = true; continue;
        }
        if (trimmed === "</siteinfo>") break;
        if (!inSiteinfo) continue;

        if (trimmed.indexOf("<base>") === 0) {
            var base = extractTagContent(trimmed);
            siteinfo.urlbase = base.substring(0, base.lastIndexOf("/"));
        } else if (trimmed.indexOf("<sitename>") === 0) {
            siteinfo.sitename = extractTagContent(trimmed);
        } else if (trimmed.indexOf("<dbname>") === 0) {
            siteinfo.dbname = extractTagContent(trimmed);
        } else if (trimmed.indexOf("<namespace") === 0) {
            var nsKey = extractAttr(trimmed, "key");
            if (nsKey !== "") {
                siteinfo.namespaces[nsKey] = extractTagContent(trimmed);
            }
        }
    }
    return siteinfo;
}

/* ================================================================
   Template loading and caching
   ================================================================ */

var templateCache = {};
var redirectCache = {};
var _siteinfo = null;
var _templateNamespace = "";
var _dumpFile = "";

function decodeEntities(text) {
    return sprintf("%!H", text);
}

function cleanTemplate(text) {
    if (!text) return "";
    text = decodeEntities(text);

    var onlyInclude = Sql.rex(">><=onlyinclude>=!</onlyinclude>*</onlyinclude>=",
        text, {submatches: false});
    if (onlyInclude.length > 0) {
        var parts = [];
        for (var i = 0; i < onlyInclude.length; i++) {
            var chunk = onlyInclude[i];
            chunk = chunk.replace('<onlyinclude>', '').replace('</onlyinclude>', '');
            parts.push(chunk);
        }
        text = parts.join('');
    } else {
        text = Sql.sandr(">><=noinclude>=!</noinclude>*</noinclude>=", "", text);
        text = Sql.sandr(">><=noinclude>=.+", "", text);
        text = Sql.sandr("<=noinclude/>=", "", text);
        text = Sql.sandr([["<=includeonly>=", ""], ["<=/includeonly>=", ""]], text);
    }
    text = Sql.sandr(">><!--=!-->*-->=", "", text);

    /* Strip extension tags from template bodies (same as article-level strip).
       These contain non-wikitext content (SPARQL, JSON, timeline DSL) that
       would leak as text debris during expansion. */
    text = Sql.sandr([
        [">><timeline=[^>]*>=!</timeline>*</timeline>=", ""],
        [">><mapframe=[^>]*>=!</mapframe>*</mapframe>=", ""],
        [">><mapframe=[^>]*/>=", ""],
        [">><maplink=[^>]*>=!</maplink>*</maplink>=", ""],
        [">><maplink=[^>]*/>=", ""],
        [">><gallery=[^>]*>=!</gallery>*</gallery>=", ""],
        [">><imagemap=[^>]*>=!</imagemap>*</imagemap>=", ""],
        [">><graph=[^>]*>=!</graph>*</graph>=", ""],
        [">><score=[^>]*>=!</score>*</score>=", ""],
        [">><templatedata=[^>]*>=!</templatedata>*</templatedata>=", ""],
        [">><categorytree=[^>]*>=!</categorytree>*</categorytree>=", ""]
    ], text);

    return text;
}

function normalizeTitle(title) {
    title = trim(title);
    title = title.replace(/_/g, ' ').replace(/\s+/g, ' ');
    if (title.length > 0)
        title = title.charAt(0).toUpperCase() + title.substring(1);
    return title;
}

function loadTemplate(name) {
    name = normalizeTitle(name);
    if (templateCache.hasOwnProperty(name)) return templateCache[name];

    var fullName = name;
    if (name.indexOf(':') < 0)
        fullName = _templateNamespace + ":" + name;

    var lmdb = _activeLmdb;
    var db = _activeDb;

    var entry = lmdb.get(db, "10:" + fullName);
    if (!entry) entry = lmdb.get(db, "10:" + name);
    if (!entry) { templateCache[name] = ""; return ""; }

    var text = readFile(_dumpFile, entry.offset, entry.length, true);

    if (entry.redirect) {
        var m = text.match(/^#REDIRECT\s*\[\[([^\]]+)\]\]/i) ||
                text.match(/^#REDIRECTION\s*\[\[([^\]]+)\]\]/i);
        if (m && !redirectCache[name]) {
            redirectCache[name] = normalizeTitle(m[1]);
            var result = loadTemplate(normalizeTitle(m[1]));
            templateCache[name] = result;
            return result;
        }
        templateCache[name] = "";
        return "";
    }

    text = cleanTemplate(text);
    templateCache[name] = text;
    return text;
}

/* ================================================================
   Magic words
   ================================================================ */

var now = new Date();
var dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
var monthNames = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
var monthAbbrevs = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function isoWeek(d) {
    var dt = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    dt.setDate(dt.getDate() + 3 - ((dt.getDay() + 6) % 7));
    var jan4 = new Date(dt.getFullYear(), 0, 4);
    return 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

function buildStaticMagicWords(siteinfo) {
    var contentLang = siteinfo.dbname ? siteinfo.dbname.replace(/wiki$/, '') : 'en';
    var serverBase = siteinfo.urlbase ? siteinfo.urlbase.replace(/\/wiki$/, '') : '';
    var serverName = siteinfo.urlbase ? siteinfo.urlbase.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
    var ts = sprintf("%04d%02d%02d%02d%02d%02d",
        now.getFullYear(), now.getMonth()+1, now.getDate(),
        now.getHours(), now.getMinutes(), now.getSeconds());

    var mw = {
        'CURRENTYEAR': sprintf("%04d", now.getFullYear()),
        'CURRENTMONTH': sprintf("%02d", now.getMonth()+1),
        'CURRENTMONTH1': String(now.getMonth()+1),
        'CURRENTMONTH2': sprintf("%02d", now.getMonth()+1),
        'CURRENTMONTHNAME': monthNames[now.getMonth()],
        'CURRENTMONTHNAMEGEN': monthNames[now.getMonth()],
        'CURRENTMONTHABBREV': monthAbbrevs[now.getMonth()],
        'CURRENTDAY': String(now.getDate()),
        'CURRENTDAY2': sprintf("%02d", now.getDate()),
        'CURRENTDOW': String(now.getDay()),
        'CURRENTDAYNAME': dayNames[now.getDay()],
        'CURRENTTIME': sprintf("%02d:%02d", now.getHours(), now.getMinutes()),
        'CURRENTHOUR': sprintf("%02d", now.getHours()),
        'CURRENTWEEK': String(isoWeek(now)),
        'CURRENTTIMESTAMP': ts,
        'SITENAME': siteinfo.sitename || '',
        'SERVER': serverBase,
        'SERVERNAME': serverName,
        'CONTENTLANGUAGE': contentLang,
        'CONTENTLANG': contentLang,
        'CURRENTVERSION': '1.45.0',
        '!': '|',
        '=': '=',
    };
    /* LOCAL* variants */
    var localKeys = ['YEAR','MONTH','MONTH1','MONTH2','MONTHNAME','MONTHNAMEGEN',
                     'MONTHABBREV','DAY','DAY2','DOW','DAYNAME','TIME','HOUR','WEEK','TIMESTAMP'];
    for (var i = 0; i < localKeys.length; i++)
        mw['LOCAL' + localKeys[i]] = mw['CURRENT' + localKeys[i]];

    return mw;
}

function buildPageMagicWords(title, siteinfo) {
    var ns = '', nsNum = '0', pagename = title;
    var colon = title.indexOf(':');
    if (colon > 0) {
        var prefix = title.substring(0, colon);
        for (var k in siteinfo.namespaces) {
            if (siteinfo.namespaces[k] === prefix) {
                ns = prefix; nsNum = k;
                pagename = title.substring(colon + 1);
                break;
            }
        }
    }
    var slash = pagename.indexOf('/');
    return {
        'PAGENAME': pagename,
        'PAGENAMEE': encodeURIComponent(pagename),
        'FULLPAGENAME': title,
        'FULLPAGENAMEE': encodeURIComponent(title),
        'NAMESPACE': ns,
        'NAMESPACEE': encodeURIComponent(ns),
        'NAMESPACENUMBER': nsNum,
        'BASEPAGENAME': slash >= 0 ? pagename.substring(0, slash) : pagename,
        'SUBPAGENAME': slash >= 0 ? pagename.substring(slash + 1) : '',
        'ROOTPAGENAME': slash >= 0 ? pagename.substring(0, pagename.indexOf('/')) : pagename,
        'TALKPAGENAME': '',
        'SUBJECTPAGENAME': title,
        'ARTICLEPAGENAME': title,
        'PAGEID': '0',
    };
}

/* ================================================================
   Active LMDB handle (set during extract/expandPage)
   ================================================================ */

var _activeLmdb = null;
var _activeDb = null;

/* ================================================================
   Process a single article
   ================================================================ */

function processArticle(title, siteinfo, staticMW) {
    var entry = _activeLmdb.get(_activeDb, "0:" + title);
    if (!entry || entry.redirect) return null;

    var text = readFile(_dumpFile, entry.offset, entry.length, true);
    text = decodeEntities(text);

    /* Strip extension tags before template expansion (matches MediaWiki behavior).
       These tags (<timeline>, <mapframe>, <gallery>, etc.) contain non-wikitext
       content (JSON, timeline DSL) whose }} and | characters would confuse
       split_parts during template parameter passing. */
    text = Sql.sandr([
        [">><timeline=[^>]*>=!</timeline>*</timeline>=", ""],
        [">><mapframe=[^>]*>=!</mapframe>*</mapframe>=", ""],
        [">><mapframe=[^>]*/>=", ""],
        [">><maplink=[^>]*>=!</maplink>*</maplink>=", ""],
        [">><maplink=[^>]*/>=", ""],
        [">><gallery=[^>]*>=!</gallery>*</gallery>=", ""],
        [">><imagemap=[^>]*>=!</imagemap>*</imagemap>=", ""],
        [">><graph=[^>]*>=!</graph>*</graph>=", ""],
        [">><score=[^>]*>=!</score>*</score>=", ""],
        [">><templatedata=[^>]*>=!</templatedata>*</templatedata>=", ""],
        [">><categorytree=[^>]*>=!</categorytree>*</categorytree>=", ""]
    ], text);

    var mw = {};
    for (var k in staticMW) mw[k] = staticMW[k];
    var pageMW = buildPageMagicWords(title, siteinfo);
    for (var k in pageMW) mw[k] = pageMW[k];

    text = wikiExpandC(text, function(name) {
        return loadTemplate(name);
    }, mw, {
        templateNamespace: siteinfo.namespaces["10"] || "Template",
        maxDepth: 30,
        maxCalls: 50000
    }, true);

    /* All cleanup now done in C: finalize_text (links, templates, params)
       + cleanup_expanded_text (HTML, whitespace) + entity decode.
       JS just trims. */
    text = trim(text);

    return text;
}

/* ================================================================
   Public API
   ================================================================ */

/*
   scan(dumpFile, lmdbPath, options)

   Scan a Wikipedia XML dump and build an LMDB index.
   Options:
     limit:  max pages to scan (0 = all)
*/
/*
   scan(dumpFile, lmdbPath, options)

   Scan a Wikipedia XML dump and build an LMDB index.
   Options:
     limit:            max pages to scan (0 = all)
     progressCallback: function(progress) called periodically
                       progress = {count, filePos, fileSize, pct, elapsed, rate, eta}
     progressInterval: call progressCallback every N pages (default 10000, 0 to disable)
*/
function scan(dumpFile, lmdbPath, options) {
    options = options || {};
    var maxPages = options.limit || 0;
    var progressCB = options.progressCallback || null;
    var progressInterval = (options.progressInterval === undefined) ? 10000 : options.progressInterval;
    if (progressInterval === null || progressInterval < 1) progressInterval = 0;

    if (!stat(dumpFile))
        throw new Error("wikiparser.scan: dump file not found: " + dumpFile);

    /* Parse siteinfo */
    var siteinfo = parseSiteinfo(dumpFile);

    /* Open LMDB */
    var lmdb = new Lmdb.init(lmdbPath, true, {
        mapSize: 2048,
        conversion: "CBOR",
        noSync: true,
        growOnPut: true
    });
    var db = lmdb.openDb("pages", true);

    /* Store siteinfo */
    lmdb.put(db, "_meta:siteinfo", siteinfo);

    /* Scan */
    var fileSize = stat(dumpFile).size;
    var pageCount = 0;
    var articleCount = 0;
    var redirectCount = 0;
    var startTime = performance.now();

    var total = scanWikiDump(dumpFile, function(ns, title, offset, length, isRedirect, filePos, pageId) {
        lmdb.put(db, ns + ":" + title, {offset: offset, length: length, redirect: isRedirect, id: pageId});
        pageCount++;
        if (ns === "0") {
            if (isRedirect) redirectCount++;
            else articleCount++;
        }

        if (progressCB && progressInterval > 0 && !(pageCount % progressInterval)) {
            var elapsed = (performance.now() - startTime) / 1000;
            var pct = filePos / fileSize * 100;
            var eta = (elapsed > 0.5 && filePos > 0) ? (fileSize - filePos) / (filePos / elapsed) : 0;
            progressCB({
                count: pageCount,
                filePos: filePos,
                fileSize: fileSize,
                pct: pct,
                elapsed: elapsed,
                rate: pageCount / elapsed,
                eta: eta
            });
        }
    }, maxPages);

    /* Store counts in LMDB for use by extract */
    lmdb.put(db, "_meta:counts", {
        pages: total,
        articles: articleCount,
        redirects: redirectCount
    });

    lmdb.sync();

    return {
        pages: total,
        articles: articleCount,
        redirects: redirectCount,
        siteinfo: siteinfo,
        elapsed: (performance.now() - startTime) / 1000
    };
}

/*
   extract(dumpFile, lmdbPath, options)

   Extract and expand articles from a scanned dump.
   Options:
     callback:         function(title, id, text, progress) — called per article
     limit:            max articles to process (0 = all)
     startKey:         start from this title prefix (e.g., "A")
     endKey:           stop at this title prefix (e.g., "B")
     progressInterval: report progress every N docs (default 1000, 0 to disable)
*/
function extract(dumpFile, lmdbPath, options) {
    options = options || {};
    var callback = options.callback;
    if (typeof callback !== 'function')
        throw new Error("wikiparser.extract: options.callback must be a function");

    var maxPages = options.limit || 0;
    var progressInterval = (options.progressInterval === undefined) ? 1000 : options.progressInterval;
    if (progressInterval === null || progressInterval < 1) progressInterval = 0;

    _dumpFile = dumpFile;
    if (!stat(dumpFile))
        throw new Error("wikiparser.extract: dump file not found: " + dumpFile);

    var lmdb = new Lmdb.init(lmdbPath, false, { conversion: "CBOR" });
    var db = lmdb.openDb("pages");
    _activeLmdb = lmdb;
    _activeDb = db;

    var siteinfo = lmdb.get(db, "_meta:siteinfo");
    if (!siteinfo)
        throw new Error("wikiparser.extract: no siteinfo in LMDB. Run scan() first.");

    _siteinfo = siteinfo;
    _templateNamespace = siteinfo.namespaces["10"] || "Template";
    var staticMW = buildStaticMagicWords(siteinfo);

    /* Reset caches */
    templateCache = {};
    redirectCache = {};

    /* Build cursor start/end keys */
    var startCursor = "0:";
    if (options.startKey) startCursor = "0:" + options.startKey;
    var endPrefix = "0:";  /* will check key.indexOf("0:") */

    /* Iterate with cursor */
    var txn = new lmdb.transaction(db, false);
    var row = txn.cursorGet(lmdb.op_setRange, startCursor, true);

    var count = 0, skipped = 0;
    var startTime = performance.now();

    while (row && row.key && row.key.indexOf("0:") === 0) {
        /* Check endKey */
        if (options.endKey && row.key >= "0:" + options.endKey) break;

        var entry = CBOR.decode(row.value);
        if (!entry.redirect) {
            var title = row.key.substring(2);
            try {
                var text = processArticle(title, siteinfo, staticMW);
                if (text && text.length > 0) {
                    count++;

                    /* Build progress info if needed */
                    var progress = null;
                    if (progressInterval > 0 && count % progressInterval === 0) {
                        var elapsed = (performance.now() - startTime) / 1000;
                        progress = {
                            count: count,
                            skipped: skipped,
                            elapsed: elapsed,
                            rate: count / elapsed
                        };
                    }

                    callback(title, entry.id || "0", text, progress);

                    if (maxPages > 0 && count >= maxPages) break;
                } else {
                    skipped++; /* empty result from expansion */
                }
            } catch(e) {
                skipped++;
            }
        } else {
            skipped++;
        }

        row = txn.cursorNext(true);
    }

    txn.abort();

    var elapsed = (performance.now() - startTime) / 1000;
    return {
        articles: count,
        skipped: skipped,
        elapsed: elapsed,
        rate: count / elapsed
    };
}

/*
   expandPage(dumpFile, lmdbPath, title)

   Expand and clean a single article. Returns the text or null.
*/
function expandPage(dumpFile, lmdbPath, title) {
    _dumpFile = dumpFile;
    if (!stat(dumpFile))
        throw new Error("wikiparser.expandPage: dump file not found: " + dumpFile);

    var lmdb = new Lmdb.init(lmdbPath, false, { conversion: "CBOR" });
    var db = lmdb.openDb("pages");
    _activeLmdb = lmdb;
    _activeDb = db;

    var siteinfo = lmdb.get(db, "_meta:siteinfo");
    if (!siteinfo)
        throw new Error("wikiparser.expandPage: no siteinfo. Run scan() first.");

    _siteinfo = siteinfo;
    _templateNamespace = siteinfo.namespaces["10"] || "Template";
    var staticMW = buildStaticMagicWords(siteinfo);

    templateCache = {};
    redirectCache = {};

    return processArticle(title, siteinfo, staticMW);
}

/* ================================================================
   Module exports
   ================================================================ */

module.exports = {
    scan: scan,
    extract: extract,
    expandPage: expandPage
};
