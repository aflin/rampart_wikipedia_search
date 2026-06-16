/* getmodel.js — ensure a GGUF model is available in the standard location.

   ensureModel(category, name, url, linkDir):
     1. ensures  ~/.rampart/models/<category>/<name>  exists (downloads if missing)
     2. symlinks it into  <linkDir>/<name>   (e.g. web_server/data/models/)
     3. returns the symlink path (the path callers should open)

   The standard model store is ~/.rampart/models/<gen|embed|rerank>/ so models are
   shared across tools/demos and downloaded only once.

   Usage:
     var getmodel = require(process.scriptPath + "/getmodel.js");
     var path = getmodel.ensureModel("embed", "all-minilm-l6-v2_f16.gguf",
                    "https://huggingface.co/.../all-minilm-l6-v2_f16.gguf",
                    process.scriptPath + "/web_server/data/models");
*/
/* library: no global side effects (don't globalize) — use a local utils alias */
var u = rampart.utils;
var curl = require("rampart-curl");

var MODELROOT = (process.env.HOME || "/tmp") + "/.rampart/models";

/* synchronous download with a progress line (see pu_test/llamacpp-test.js) */
function download(url, dest) {
    u.printf("Downloading %s\n  -> %s\n", url, dest);
    var f = u.fopen(dest, "w+");
    var nchunks = 0;
    try {
        curl.fetch(url, {
            location:     true,
            returnText:   false,
            skipFinalRes: true,
            chunkCallback: function(res) { f.fprintf("%s", res.body); },
            progressCallback: function(res) {
                if (nchunks++ % 30) return;
                var tot = res.progress, rate = tot / (res.totalTime * 1024), unit = "KB/s";
                if (rate > 1024) { rate /= 1024; unit = "MB/s"; }
                if (res.expectedTotal != -1)
                    u.printf("\r    %.1f%%  %d / %d bytes  (%.2f %s)   ",
                           100 * tot / res.expectedTotal, tot, res.expectedTotal, rate, unit);
                else
                    u.printf("\r    %d bytes   ", tot);
                u.fflush(u.stdout);
            },
            callback: function() {}
        });
    } catch (e) {
        f.fclose();
        try { u.rmFile(dest); } catch (e2) {}
        throw new Error("download failed for " + url + ": " + (e.message || e));
    }
    f.fclose();
    var st = u.stat(dest);
    if (!st || st.size === 0) {
        try { u.rmFile(dest); } catch (e) {}
        throw new Error("download produced no data: " + url);
    }
    u.printf("\r    done: %d bytes%20s\n", st.size, "");
}

/* Embedding-model policy by language. English and Simple English use the small,
   fast, English-tuned MiniLM (384-dim). Every OTHER language uses the
   multilingual bge-m3 (Q8_0, 1024-dim) — MiniLM is English-centric and gives
   poor cross-lingual vectors. (Q8_0 is retrieval-equivalent to FP16 for bge-m3;
   see embed_quant_probe.js.) */
var EMBED_MODELS = {
    minilm: {
        name: "all-minilm-l6-v2_f16.gguf",
        url:  "https://huggingface.co/LLukas22/all-MiniLM-L6-v2-GGUF/resolve/main/all-minilm-l6-v2_f16.gguf"
    },
    bgem3: {
        name: "bge-m3-Q8_0.gguf",
        url:  "https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf"
    }
};

function embedModelFor(lang) {
    lang = (lang || "en").toLowerCase();
    return (lang === "en" || lang === "simple") ? EMBED_MODELS.minilm : EMBED_MODELS.bgem3;
}

/* Build an ensureModel() confirm callback. For en/simple (the tiny MiniLM) it
   auto-confirms; for any other language it prompts, since those pull the
   ~600 MB multilingual bge-m3. Only ever called when a download is actually
   needed (model absent), so an already-present model never prompts. */
function confirmEmbedDownload(lang) {
    lang = (lang || "en").toLowerCase();
    return function (name /*, url, target */) {
        if (lang === "en" || lang === "simple") return true;   // tiny model: just fetch
        u.printf("\nLanguage '%s' uses the multilingual embedding model:\n  %s  (~600 MB)\n",
                 lang, name);
        u.printf("It is not present yet. Download it now? [Y/n] ");
        u.fflush(u.stdout);
        var c = u.stdin.getchar(1);
        u.printf("\n");
        return !(c === 'n' || c === 'N');
    };
}

/* ensureModel(category, name, url, linkDir [, opts])
     opts.confirm(name, url, target) -> boolean : called ONLY when a download is
       actually required (the model isn't in the link dir or the store). Return
       false to decline; ensureModel then returns null. Omit it to download
       silently (the web server / non-interactive callers). */
function ensureModel(category, name, url, linkDir, opts) {
    var link = linkDir + "/" + name;

    // FAST PATH: if the model (or a symlink to it) already exists in the link dir,
    // use it as-is — no store lookup, no download, no relinking.
    if (u.stat(link))
        return link;

    // else ensure it in the standard store ~/.rampart/models/<category>/ ...
    var store  = MODELROOT + "/" + category;
    var target = store + "/" + name;
    if (!u.stat(target)) {
        if (opts && typeof opts.confirm === "function" && !opts.confirm(name, url, target))
            return null;              // caller declined the download
        u.mkdir(store);               // mkdir creates parents
        download(url, target);
    } else {
        u.printf("model '%s' present: %s\n", name, target);
    }

    // ... and symlink it into the link dir (web_server/data/models)
    u.mkdir(linkDir);
    if (u.lstat(link)) { try { u.rmFile(link); } catch (e) {} }  // drop a broken/old link
    u.symlink(target, link);          // symlink(src=real file, target=link path)
    u.printf("linked %s -> %s\n", link, target);

    return link;
}

module.exports = {
    ensureModel:          ensureModel,
    embedModelFor:        embedModelFor,
    confirmEmbedDownload: confirmEmbedDownload,
    EMBED_MODELS:         EMBED_MODELS,
    modelRoot:            MODELROOT
};
