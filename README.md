# Rampart Wikipedia Search Demo

A demo search of Wikipedia (in one or several languages of your choice)
using the Rampart SQL module on Linux or macOS.  Two builds are offered:

* **Keyword search** (`wikidocs`) — classic full-text search.  Fast to
  build; powerful and efficient enough to run on hardware as small as a
  Raspberry Pi Zero.
* **Fused vector + keyword search** (`wikivecs`) — the same articles plus
  multi-vector chunk embeddings (`chunkembed()`) in one table.  Semantic
  (`likev`), keyword (`likep`) and hybrid search with best-chunk
  abstracts and cross-encoder reranking.  Needs real hardware to build:
  preferably CUDA (use the cuda build of
  [rampart-langtools](https://rampart.dev/downloads/latest/)) or an
  Apple-Silicon Mac; a plain CPU build works but takes much longer.

The two tables are identical except for the vector column, so whichever
one exists can serve as the source for building the other — the dump is
parsed only once.

## Usage

```
./make-wiki-search.sh
```

The script asks for the language ('en', 'de', ...; can be run repeatedly
for different languages), which of the two searches to build, the
embedding model (fused build), and the worker-thread count, then:

1. downloads and decompresses the Wikipedia dump for that language, if
   (and only if) no existing table can serve as the source;
2. builds `wikidocs` (`build-wikidocs.js`) or `wikivecs`
   (`build-wikivecs.js`) — scan, template expansion, extraction and (for
   the fused build) chunk embedding, across N worker threads;
3. builds all indexes (`mkindex.js`): btree on Id, full-text metamorph on
   Doc, and (fused) the IVFPQ vector index on Vec.

Then start the server:

```
cd web_server
./start_wikipedia_web_server.sh
```

* Keyword search: http://localhost:8088/apps/wikipedia_search/search.html
* Fused search:   http://localhost:8088/apps/wikipedia_search/vecsearch.html
* JSON endpoint (RAG-friendly): http://localhost:8088/apps/wikipedia_search/vecsearch.json?q=...

Server settings live in `web_server/web_server_conf.js`.

### Test mode

```
./make-wiki-search.sh test        # fused build of Simple English (~350MB dump)
./make-wiki-search.sh test k      # keyword-only variant
```

Runs the whole flow non-interactively on the small, complete
Simple-English dump — minutes-to-hours instead of days.

## Embedding models (fused build)

Models come from the rampart-models catalog (installed with
rampart-langtools); `make-wiki-search.sh` presents a curated menu — from
the tiny English `bge-small-en-v1.5` (384 dim, the default) to the
multilingual `bge-m3` (1024 dim, the non-English default) and
`qwen3-embedding-0.6b` (best quality, GPU advised).  Run
`rampart wikilib.js menu` to see it.  Any other catalog alias may be
typed at the prompt.

The details are handled automatically:

* **Engine** — llamacpp (gguf) by default everywhere: the same quantized
  model runs well on CUDA, Metal and plain CPU.  onnx is used only for
  models with no gguf form (multilingual-e5-small), or explicitly:
  `rampart build-wikivecs.js <lc> <alias> <threads> onnx`.
* **Retrieval prompts** — asymmetric models (nomic, e5, qwen3, ...) get
  their document prompts applied during `chunkembed()` and their query
  prompts at search time, from the `.prompts.json` sidecars that
  rampart-models writes next to each downloaded model.
* **model.json** — each fused database records the model that built it in
  `web_server/data/<lc>_wikipedia_search/model.json`; `mkindex.js` and
  the search app read it, so queries are always embedded with the same
  model+engine as the table.
* **Reranker** — the `bge-reranker-v2-m3` cross-encoder re-orders the top
  fused results.  Optional: if the model isn't downloaded (the build
  offers to) or rampart-langtools is missing it, the search runs
  unreranked.

An interrupted embedding run can be resumed: re-run the build and choose
`[r]esume` — already-embedded articles are skipped.

## Files

| file | purpose |
|---|---|
| `make-wiki-search.sh` | interactive build coordinator |
| `build-wikidocs.js`   | keyword table: parse the dump (or copy from wikivecs) |
| `build-wikivecs.js`   | fused table: parse or copy from wikidocs + chunkembed |
| `mkindex.js`          | all indexes for whichever tables exist (safe to re-run) |
| `wikilib.js`          | model menu / engine policy / model.json / reranker (also a CLI) |
| `wikiparser/`         | dump scanner + template expansion + text extraction |
| `web_server/`         | the demo web server (search.js, vecsearch.js) |

## Required

1. [Rampart JavaScript](https://github.com/aflin/rampart) version ≥ 0.7.1
   plus rampart-langtools (for the fused build)
2. curl
3. A C compiler (for the embedded C in wikiparser/wikiparser.js)
4. bzcat (part of the bzip2 package)
5. pv (optional, for a decompression progress bar)
6. Patience.  A full-English fused build is measured in days on CPU,
   hours on a good GPU.  The keyword-only build is hours.
