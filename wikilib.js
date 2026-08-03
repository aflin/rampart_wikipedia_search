/* wikilib.js — shared helpers for the rws2 wikipedia search build.

   One module, three jobs:

   1. MODEL CATALOG POLICY — the curated menu of embedding models (dim,
      multilingual, speed notes), per-language defaults, and the
      llamacpp-vs-onnx engine auto-choice.  Downloads go through the
      rampart-models module (installed with rampart-langtools), which also
      writes the .prompts.json sidecars so asymmetric models (nomic, e5,
      qwen3, ...) get their query/document prompts applied automatically
      by chunkembed()/likev.

   2. model.json — every fused database records the model it was built
      with in <dbdir>/model.json:
          { alias, engine, dim, multilingual, created }
      Only the ALIAS is stored; the model file is resolved from it via
      rampart-models (the shared ~/.rampart/models/ store) at both build
      and serve time -- nothing is copied or symlinked into the tree, so
      the db is portable.  build-wikivecs.js writes it, mkindex.js reads
      dim from it, and vecsearch.js uses it to embed queries with EXACTLY
      the model+engine that built the table.

   3. RERANKER — ensureReranker()/initReranker() fetch and load the
      bge-reranker-v2-m3 cross-encoder with the same engine policy.

   Also usable from the shell (make-wiki-search.sh):
       rampart wikilib.js menu <lc>            # print the model menu
       rampart wikilib.js resolve <choice> <lc># menu number|alias -> alias
       rampart wikilib.js engine <alias>       # print chosen engine + why
       rampart wikilib.js threads [keyword]    # "<gpu|cpu> <n>" thread default
                                               #   (keyword = CPU-bound parse)
       rampart wikilib.js reranker             # pre-download the reranker
*/

/* library: no global side effects — use a local utils alias */
var u = rampart.utils;
var models = require("rampart-models");

/* ------------------------------------------------------------------ *
 * curated embedding-model menu
 *
 * All of these were verified end-to-end (document/query prompts, wiki-
 * scale retrieval) against the rampart-models catalog.  dim/multilingual
 * are recorded here because the catalog does not carry dimensions.
 * "speed" is embed cost on CPU relative to all-minilm-l6-v2 (rough).
 * ------------------------------------------------------------------ */
var MENU = [
    { alias: "all-minilm-l6-v2",       dim: 384,  multilingual: false,
      speed: "1x",   note: "fastest; the original demo baseline" },
    { alias: "bge-small-en-v1.5",      dim: 384,  multilingual: false,
      speed: "1x",   note: "same speed class, better quality", enDefault: true },
    { alias: "bge-base-en-v1.5",       dim: 768,  multilingual: false,
      speed: "1.5x", note: "stronger English retrieval" },
    { alias: "nomic-embed-text-v1.5",  dim: 768,  multilingual: false,
      speed: "2.5x", note: "8k context, strong English retrieval" },
    { alias: "multilingual-e5-small",  dim: 384,  multilingual: true,
      speed: "1.5x", note: "smallest multilingual (onnx only)" },
    { alias: "multilingual-e5-base",   dim: 768,  multilingual: true,
      speed: "3x",   note: "good multilingual quality" },
    { alias: "bge-m3",                 dim: 1024, multilingual: true,
      speed: "6x",   note: "8k context, strong multilingual", multiDefault: true },
    { alias: "qwen3-embedding-0.6b",   dim: 1024, multilingual: true,
      speed: "10x",  note: "best quality; GPU strongly advised" }
];

function menuEntry(alias) {
    for (var i = 0; i < MENU.length; i++)
        if (MENU[i].alias === alias) return MENU[i];
    return null;
}

function defaultAlias(lc) {
    var en = (lc === "en" || lc === "simple");
    for (var i = 0; i < MENU.length; i++)
        if (en ? MENU[i].enDefault : MENU[i].multiDefault) return MENU[i].alias;
    return MENU[0].alias;
}

/* ------------------------------------------------------------------ *
 * platform + engine policy
 * ------------------------------------------------------------------ */
var _plat = null;
function platform() {
    if (_plat) return _plat;
    var un = "";
    try { un = u.exec("uname", { args: ["-sm"] }).stdout.trim(); } catch (e) {}
    _plat = {
        os:   /darwin/i.test(un) ? "macos" : "linux",
        arch: /arm64|aarch64/.test(un) ? "arm64" : "x86_64",
        cuda: !!u.stat("/proc/driver/nvidia/version")
    };
    /* "gpu" for the thread-count default: CUDA on linux, Metal on apple
     * silicon — either way a few workers saturate the device. */
    _plat.gpu = _plat.cuda || (_plat.os === "macos" && _plat.arch === "arm64");
    return _plat;
}

/* Engine choice: llamacpp (gguf) BY DEFAULT, everywhere.
 *
 * llamacpp runs the same quantized gguf well on CUDA, Metal and plain
 * CPU with no surprises.  onnx is faster in the right conditions (its
 * CUDA EP on bert-family models) but its wins are conditional: CoreML
 * is weak on macOS, and models outside the plain-bert family can fall
 * back to CPU per-op (nomic on the CUDA EP: 5 vs llamacpp's 127
 * docs/sec on the same GPU).  So onnx is used only when the model has
 * no sound gguf (multilingual-e5-small) or when explicitly requested
 * (build-wikivecs.js <lc> <alias> <threads> onnx). */
function chooseEngine(alias, override) {
    var entry = models.catalog[alias] || models.resolve(alias);
    if (!entry) throw new Error("unknown embed model '" + alias + "'");
    var have = { gguf: !!entry.gguf, onnx: !!entry.onnx };

    if (override) {
        if (!have[override])
            throw new Error("model '" + alias + "' has no " + override + " format");
        return { engine: override, why: "requested" };
    }
    if (have.gguf)
        return { engine: "gguf", why: "llamacpp default: gguf runs everywhere (CUDA/Metal/CPU)" };
    if (have.onnx)
        return { engine: "onnx", why: "only format this model provides" };
    throw new Error("model '" + alias + "' has no gguf or onnx format");
}

/* ------------------------------------------------------------------ *
 * model materialization -- ALWAYS via rampart-models.js, which keeps
 * one shared store at ~/.rampart/models/<category>/.  Nothing is copied
 * or symlinked into the web_server tree: a database records only the
 * model ALIAS (in model.json), and every process -- builder or server,
 * whatever its working directory -- resolves that alias back to the same
 * canonical file (downloading it once if absent).  So a db directory is
 * portable: copy it anywhere and the alias re-resolves.
 * ------------------------------------------------------------------ */

/* Resolve (and download if needed) the model for `alias` on `engine`,
 * returning its ~/.rampart/models path: the .gguf file for llamacpp, the
 * model DIRECTORY for onnx.
 *
 * rampart-models hands back the bare .onnx file, but the directory is the
 * documented entry point for both onnx.initEmbed() and onnx.initRerank(),
 * and only directory mode discovers the tokenizer, pooling and token
 * window from the model's own config files.  A bare .onnx is "file mode",
 * which makes an explicit tokenizer_path mandatory (sql.set fails without
 * it) and skips pooling discovery entirely -- so a sentence-transformers
 * model that did load would embed with the wrong pooling.
 *
 * The one thing the directory loses is which precision was fetched:
 * rampart-onnx picks onnx/model.onnx, else model.onnx, else the first
 * *.onnx it finds.  Nothing here asks for a precision, so each alias
 * holds only its default fp16 download and the choice is unambiguous --
 * but a caller that fetched a second precision for the same alias (e.g.
 * ensureReranker({precision:'q4'})) would leave two files in one
 * directory, and the load could pick either. */
function onnxModelDir(p) {
    var st = u.stat(p);
    if (st && st.isDirectory) return p;         /* already a directory */
    var dir = p.replace(/\/[^\/]*$/, "");       /* strip the file name */
    if (/\/onnx$/.test(dir)) dir = dir.replace(/\/onnx$/, "");
    return (u.stat(dir) || {}).isDirectory ? dir : p;
}

function resolveModel(alias, engine, opts) {
    opts = opts || {};
    var o = { progress: opts.progress !== false,
              confirm: function (info) {
                  u.printf("model %s [%s]: %s (%s) -> %s\n",
                           alias, info.format, info.repo, info.size, info.dest);
                  return true;
              } };
    if (engine === "gguf") return models.ggufGet(alias, o);
    return onnxModelDir(models.onnxGet(alias, o));
}

/* Kept for the build path + reranker: ensure the model is on disk and
 * return { alias, engine, path } where path is its ~/.rampart location. */
function ensureEmbedModel(alias, engine, opts) {
    return { alias: alias, engine: engine, path: resolveModel(alias, engine, opts) };
}

/* sql.set the embedder for a model.json-shaped info object.  The path is
 * resolved from the ALIAS through rampart-models (the ~/.rampart store),
 * never from anything inside the db or web_server tree. */
function setEmbed(sql, info) {
    if (!info || !info.alias)
        throw new Error("wikilib.setEmbed: model.json has no 'alias' field -- " +
                        "rebuild it as { alias, engine, dim, ... } (model paths " +
                        "are always resolved through rampart-models)");
    var path = resolveModel(info.alias, info.engine, { progress: false });
    /* Fail loudly with the FULL resolved path when the model file is not
     * there, instead of handing a bad path to the engine (whose
     * "llama_init_from_model failed" hides which path it tried).  This
     * surfaces e.g. a HOME/store mismatch under a root-started server. */
    if (!u.stat(path))
        throw new Error("wikilib.setEmbed: model file not found: " + path +
                        "  (alias '" + (info.alias || "?") + "', engine " +
                        info.engine + ", HOME=" + (u.getenv("HOME") || "?") + ")");
    /* NOTE: no getLog()/resetLog() here — on a thread-copied module handle
     * (i.e. inside a server worker thread) those throw, which would mask
     * the engine's real error.  On failure, append the model path so the
     * engine's message at least names what it was loading. */
    try {
        if (info.engine === "gguf")
            sql.set({ llamaEmbed: path });
        else
            sql.set({ onnxEmbed: { model: path } });
    } catch (e) {
        throw new Error((e.message || "" + e) + "  (model: " + path + ")");
    }
    return path;
}

/* ------------------------------------------------------------------ *
 * model.json
 * ------------------------------------------------------------------ */
function readModelJson(dbdir) {
    try { return JSON.parse(u.readFile(dbdir + "/model.json", { retString: true })); }
    catch (e) { return null; }
}

function writeModelJson(dbdir, info) {
    u.writeFile(dbdir + "/model.json", u.sprintf("%3J\n", info));
}

/* ------------------------------------------------------------------ *
 * reranker (bge-reranker-v2-m3 cross-encoder), same engine policy
 * ------------------------------------------------------------------ */
var RERANKER = "bge-reranker-v2-m3";

function ensureReranker(opts) {
    var eng = chooseEngine(RERANKER, opts && opts.engine).engine;
    return ensureEmbedModel(RERANKER, eng, opts);
}

/* Load the reranker; returns a handle with .rerank(query, text) -> number
 * or null when the model/module is unavailable (search then keeps the
 * merged likev/likep order).  Meant for web_server_conf.js's post-fork
 * init; the handle is shared by all server threads. */
function initReranker() {
    var info;
    try { info = ensureReranker({ progress: false }); }
    catch (e) {
        u.fprintf(u.stderr, "wikilib: reranker model unavailable (%s); reranking disabled\n",
                  e.message || e);
        return null;
    }
    try {
        if (info.engine === "gguf") {
            var llamacpp = require("rampart-llamacpp");
            return llamacpp.initRerank(info.path, { ubatch: 256 });
        }
        var onnx = require("rampart-onnx");
        return onnx.initRerank(info.path);
    } catch (e) {
        u.fprintf(u.stderr, "wikilib: reranker failed to load (%s); reranking disabled\n",
                  e.message || e);
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * misc shared bits
 * ------------------------------------------------------------------ */
function formatTime(seconds) {
    if (seconds < 60) return seconds.toFixed(0) + "s";
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    if (m < 60) return m + "m" + (s < 10 ? "0" : "") + s + "s";
    var h = Math.floor(m / 60);
    m = m % 60;
    return h + "h" + (m < 10 ? "0" : "") + m + "m";
}

/* Default worker-thread count, by what the work actually costs:
 *
 *   "parse"  (build-wikidocs: template expansion + inserts) never
 *            touches the GPU, so it scales with cores -- but only up to
 *            a point: every worker writes to the SAME table through its
 *            own sql_helper, so past a handful the build is bound by
 *            insert/lock/IO rather than CPU.  Measured on a 20-core
 *            Mac Studio (NVMe), simple-wiki 282,837 articles:
 *              2 thr 319s | 4 thr 161s | 6 thr 123s | 8 thr 109s
 *             12 thr  95s | 16 thr  98s | 20 thr  97s
 *            i.e. near-linear to 4, thin gains to 12, and NEGATIVE past
 *            it.  8 captures ~87% of the best time with a third of the
 *            helpers, and is the safer pick since slower storage moves
 *            the knee DOWN, never up.  Pass an explicit count to go
 *            higher (12 is the practical ceiling on fast disks).
 *
 *   "embed"  (build-wikivecs) is dominated by the model.  On a GPU
 *            (CUDA or Metal) a few workers already saturate the device
 *            and more only add VRAM pressure; on CPU the model contexts
 *            are the memory limit, so scale with cores but capped.
 */
function defaultThreads(kind) {
    var cpu = process.nCpu || 4;
    if (kind === "parse") return Math.min(cpu, 8);
    return platform().gpu ? 4 : Math.min(cpu, 12);
}

/* ------------------------------------------------------------------ *
 * module / CLI
 * ------------------------------------------------------------------ */
if (module && module.exports) {
    module.exports = {
        MENU: MENU,
        menuEntry: menuEntry,
        defaultAlias: defaultAlias,
        platform: platform,
        chooseEngine: chooseEngine,
        ensureEmbedModel: ensureEmbedModel,
        setEmbed: setEmbed,
        readModelJson: readModelJson,
        writeModelJson: writeModelJson,
        RERANKER: RERANKER,
        ensureReranker: ensureReranker,
        initReranker: initReranker,
        formatTime: formatTime,
        defaultThreads: defaultThreads
    };
} else {
    var argv = process.argv.slice(2);
    var cmd = argv[0] || "";

    if (cmd === "menu") {
        var lc = argv[1] || "en";
        var def = defaultAlias(lc);
        u.printf("Embedding models (cpu cost relative to all-minilm-l6-v2):\n\n");
        for (var i = 0; i < MENU.length; i++) {
            var m = MENU[i];
            u.printf("  %d) %-24s %4d dim  %-12s %-5s %s%s\n",
                     i + 1, m.alias, m.dim,
                     m.multilingual ? "multilingual" : "English",
                     m.speed, m.note,
                     m.alias === def ? "  [default]" : "");
        }
        u.printf("\n");
    } else if (cmd === "resolve") {
        /* menu number, alias, or empty (-> language default); prints the
         * alias on success, exits 1 on garbage. */
        var choice = argv[1] || "", lc = argv[2] || "en";
        var alias = null;
        if (!choice.length) alias = defaultAlias(lc);
        else if (/^\d+$/.test(choice)) {
            var n = parseInt(choice);
            if (n >= 1 && n <= MENU.length) alias = MENU[n - 1].alias;
        } else if (menuEntry(choice.toLowerCase())) alias = choice.toLowerCase();
        else if (models.catalog[choice.toLowerCase()]) {
            /* escape hatch: any catalog alias, even off-menu */
            alias = choice.toLowerCase();
            u.fprintf(u.stderr, "note: '%s' is not on the curated menu; using it anyway\n", alias);
        }
        if (!alias) { u.fprintf(u.stderr, "unknown model choice '%s'\n", choice); process.exit(1); }
        u.printf("%s\n", alias);
    } else if (cmd === "engine") {
        if (!argv[1]) { u.fprintf(u.stderr, "usage: rampart wikilib.js engine <alias>\n"); process.exit(1); }
        var ch = chooseEngine(argv[1]);
        u.printf("%s (%s)\n", ch.engine === "gguf" ? "llamacpp" : "onnx", ch.why);
    } else if (cmd === "gpu" || cmd === "threads") {
        /* "<gpu|cpu> <default threads>" for the named work; the kind
         * matters because the keyword build never uses the GPU. */
        var kind = (argv[1] === "parse" || argv[1] === "keyword") ? "parse" : "embed";
        u.printf("%s %d\n", platform().gpu ? "gpu" : "cpu", defaultThreads(kind));
    } else if (cmd === "reranker") {
        var r = ensureReranker();
        u.printf("reranker ready: %s [%s]\n", r.path, r.engine);
    } else {
        u.printf("usage: rampart wikilib.js menu <lc> | resolve <choice> <lc> | engine <alias> | gpu | reranker\n");
        process.exit(cmd.length ? 1 : 0);
    }
}
