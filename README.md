# rampart_wikipedia_search A demo full text search of Wikipedia (in one or
several languages of your choice) using the Rampart SQL module on Linux or
MacOs.  The search is powerful and efficient enough to be run on hardware as
small as a Raspberry Pi Zero.

## Usage:
Running ``./make_wiki-search.sh`` will initiate the build. It will ask for the version (such as 'en' or 'de') and can be run multiple times with different languages. The script will provide some information and then:

1. Download the latest wikipedia dump from dumps.wikipedia.org for the chosen language.
2. Decompress the downloaded file.
3. Import the data using import.js or import-multithread.js.
4. Create the index using mkindex.js

## To build the semantic search

The semantic search uses rampart-faiss and rampart-llamacpp to build perform a
semantic search.  The build splits the wikipedia articles into paragraphs,
creates a semantic vector using llamacpp and the chosen model and creates a
faiss index for fast search in the semantic vector space.

For the semantic search, a raspberry pi will be inadequate.  Preferably use
a linux box with CUDA and an Nvidia card (works fine with CPU, just a slower
build) or a Mac with M1 or better.  If using cuda, make sure you use the cuda build
of rampart-langtools available [here](https://rampart.dev/downloads/latest/)

The semantic search build script currently only handles the English build of the
wikipedia search above.  However, changing a few variables and the default model
will make it work with other languages.

After building with ``./make_wiki-search.sh``:

1. Download a embeddings model like [all-MiniLM-L6-v2-GGUF](https://huggingface.co/LLukas22/all-MiniLM-L6-v2-GGUF/tree/main)
  (384 dim; English; default in the script) or 
  [bge-m3-FP16.gguf](https://huggingface.co/gpustack/bge-m3-GGUF/tree/main) (1024 dim; multi-lingual).
2. Run ``rampart build-wikivecs.js``
3. Download a reranker such as [bge-reranker-v2-m3-q8_0.gguf](https://huggingface.co/klnstpr/bge-reranker-v2-m3-Q8_0-GGUF/tree/main)
  Or if limited to a small cpu setup and reranking proves too slow, edit
  web_server/web_server_start.js and
  web_server/apps/wikipedia_search/vecsearch.js to remove the reranking
  step.  The reranking step mostly helps to bring more relevant results to
  the top (i.e.  it pull the ``"Kill Bill: Volume 1"`` paragraph mentioning
  David Carradine and a paragraph from the ``"David Carradine"`` page to the top
  two results for a search like ``"what is the name of the actor that played
  bill in kill bill"`` where they would otherwise be out of the top 10, but in
  the top 30).  If that is not needed, it can be skipped to save resources
  and significantly speed up the search.
4. A demo will be available at http://localhost:8088/apps/wikipedia_search/vecsearch.html
  A JSON endpoint more suitable for a RAG pipeline will be available at http://localhost:8088/apps/wikipedia_search/vecsearch.json
5. Restart the server ``rampart web_server_conf.js restart``.

## Required:

1. [Rampart JavaScript](https://github.com/aflin/rampart)
2. Curl
3. A C compiler to compile the embedded c in wikiparser/wikiparser.js
4. bzcat (part of the bzip2 package)
5. pv (optional to display a progress bar while decompressing)
6. Patience.  The entire build with semantic search will likely consume 2 days.

Note: python is no longer required. The wikiparser.js script with parallel
build will now reduce the run time of the parallel ``./make_wiki-search.sh``
to hours instead of days, with better text extraction.
 
## Demo:

An English demo running on the Raspberry Pi Zero can be found [here](https://rampart.dev/apps/wikipedia/).
An English demo of the vector search on a Mac Studio can be found [here](https://rampart.dev/apps/vecsearch/).
