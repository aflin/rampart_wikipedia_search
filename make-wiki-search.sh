#!/bin/bash

# make-wiki-search.sh — build a Wikipedia search database.
#
# Coordinates the whole build:
#   1. asks which language Wikipedia to use (downloads + decompresses the
#      dump only when it's actually needed)
#   2. asks whether to build the keyword-only search (wikidocs) or the
#      fused vector+keyword search (wikivecs)
#   3. for the fused build: asks which embedding model to use, and picks
#      the llamacpp/onnx engine automatically for this machine
#   4. asks how many worker threads to use (default: 4 on a GPU box,
#      one per core capped at 12 on CPU)
#   5. runs the build (build-wikidocs.js / build-wikivecs.js), then
#      builds all indexes (mkindex.js)
#
# TEST MODE: build from the small, complete Simple-English dump (~350MB
# vs >17GB for full English) so the whole flow can be exercised quickly,
# non-interactively:
#     ./make-wiki-search.sh test        # fused build (default model)
#     ./make-wiki-search.sh test k      # keyword-only build

cd "$(dirname "$0")" || exit 1

die () {
    echo "$1"
    exit 1
}

# Set the name of the user that the web server will run under (the account
# that starts it, or the name set in web_server_conf.js if started as root).
WEBUSER="nobody"

RP=`which rampart`
[ -z "$RP" ] && die "Can't find rampart executable"

ME=`whoami`

curl --version &>/dev/null || die "curl must be installed and in the current \$PATH before running this script"

HAVEPV=""
pv --help &>/dev/null && HAVEPV="1" || {
    echo "NOTE: install pv (e.g. \"apt install pv\") for a progress bar while decompressing."
    echo
}

# ---------------------------------------------------------------- language
FILE="enwiki-latest-pages-articles.xml"
DUMPURL="https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-pages-articles.xml.bz2"

TESTMODE=""
BUILDTYPE=""
if [ "$1" == "test" ] || [ "$WPTEST" == "1" ]; then
    TESTMODE="1"
    LC="simple"
    FILE="simplewiki-latest-pages-articles.xml"
    DUMPURL="https://dumps.wikimedia.org/simplewiki/latest/simplewiki-latest-pages-articles.xml.bz2"
    if [ "$2" == "k" ]; then BUILDTYPE="k"; else BUILDTYPE="f"; fi
    echo "*** TEST MODE: Simple English Wikipedia (${DUMPURL##*/}, ~350MB) -> ${LC}_wikipedia_search ***"
    echo
else
    echo "Which Wikipedia dump would you like to use?"
    echo "  Use language code es for Spanish, en for English, de for German, fr for French, etc."
    echo
    read -p "Lang code (enter for English): " LC
    if [ "$LC" == "" ]; then
        LC="en"
    else
        FILE="${LC}wiki-latest-pages-articles.xml"
        DUMPURL="https://dumps.wikimedia.org/${LC}wiki/latest/${LC}wiki-latest-pages-articles.xml.bz2"
    fi
fi

DBDIR="./web_server/data/${LC}_wikipedia_search"

# ---------------------------------------------------------------- build type
if [ -z "$BUILDTYPE" ]; then
    echo
    echo "Which search would you like to build?"
    echo "  1) keyword search only        (fast to build; runs on tiny hardware)"
    echo "  2) fused vector + keyword     (semantic search; embedding the articles"
    echo "                                 takes hours on a GPU, longer on CPU)"
    read -p "Choice [2]: " -n 1 -r
    echo
    if [[ $REPLY == "1" ]]; then BUILDTYPE="k"; else BUILDTYPE="f"; fi
fi

# ---------------------------------------------------------------- model
ALIAS=""
if [ "$BUILDTYPE" == "f" ]; then
    if [ -n "$TESTMODE" ]; then
        ALIAS=$($RP wikilib.js resolve "" "$LC") || die "could not resolve default model"
    else
        echo
        $RP wikilib.js menu $LC || die "could not load the model menu (is rampart-langtools installed?)"
        read -p "Model (number or alias, enter for default): " MCHOICE
        ALIAS=$($RP wikilib.js resolve "$MCHOICE" "$LC") || die "unknown model choice '$MCHOICE'"
    fi
    ENGINE=$($RP wikilib.js engine $ALIAS) || die "could not choose an engine for $ALIAS"
    echo
    echo "Model:  $ALIAS"
    echo "Engine: $ENGINE"
fi

# ---------------------------------------------------------------- threads
# The two builds have different bottlenecks, so they get different
# defaults: the keyword build is pure CPU (expanding templates) and never
# touches the GPU, while the fused build is dominated by the embedding
# model.  Ask wikilib for the right default for the build being made.
if [ "$BUILDTYPE" == "k" ]; then THREADKIND="keyword"; else THREADKIND="embed"; fi
GPUINFO=$($RP wikilib.js threads $THREADKIND) || die "could not probe the platform"
GPUKIND=${GPUINFO% *}
DEFTHREADS=${GPUINFO#* }
if [ -n "$TESTMODE" ]; then
    NTHREADS=$DEFTHREADS
else
    echo
    if [ "$BUILDTYPE" == "k" ]; then
        echo "Worker threads.  The keyword build expands templates on the CPU and does"
        echo "not use the GPU, so the default is ${DEFTHREADS}.  All workers write to the same"
        echo "table, so past roughly 8 the build waits on inserts rather than the CPU"
        echo "(measured: 8 threads within ~13% of the best time, 16 slightly slower)."
    elif [ "$GPUKIND" == "gpu" ]; then
        echo "Worker threads.  This machine has a GPU: a few workers are enough to"
        echo "saturate it, so the default is ${DEFTHREADS}.  Raise it only if the GPU is not"
        echo "fully utilized during the build."
    else
        echo "Worker threads.  CPU embedding: the default is one per core, capped at 12"
        echo "(each worker runs its own model context; more mostly adds memory use)."
    fi
    read -p "Worker threads [default ${DEFTHREADS}]: " NTHREADS
    case "$NTHREADS" in
        "")          NTHREADS=$DEFTHREADS ;;
        *[!0-9]*|0)  echo "Invalid count '$NTHREADS'; using ${DEFTHREADS}."; NTHREADS=$DEFTHREADS ;;
    esac
fi
echo

# ---------------------------------------------------------------- dump
# The dump is only needed when there is no existing table to build from:
# wikidocs and wikivecs are identical except for the vector column, so
# either can be (re)built from the other without parsing.
NEED_DUMP="1"
if [ -e "$DBDIR/wikidocs.tbl" ] || [ -e "$DBDIR/wikivecs.tbl" ]; then
    NEED_DUMP=""
    if [ "$BUILDTYPE" == "f" ] && [ ! -e "$DBDIR/wikidocs.tbl" ] && [ -z "$TESTMODE" ]; then
        # only a wikivecs table exists; if it's a PARTIAL build being
        # resumed (and there's no wikidocs to read from), the resume
        # re-reads the dump.
        read -p "wikivecs exists.  Will you be resuming an interrupted build (needs the dump)? [y/N] " -n 1 -r
        echo
        [[ $REPLY =~ ^[Yy]$ ]] && NEED_DUMP="1"
    fi
fi

decompress () {
    echo "Decompressing ${FILE}.bz2 ..."
    if [ "$HAVEPV" == "1" ]; then
        cat "${FILE}.bz2" | pv -s $(ls -l "${FILE}.bz2" | awk '{print $5}') | bzcat -d > "$FILE" || die "Failed to decompress file"
    else
        cat "${FILE}.bz2" | bzcat -d > "$FILE" || die "Failed to decompress file"
    fi
}

download () {
    if [ -z "$TESTMODE" ]; then
        echo
        echo "The Wikipedia dump file is very large (>17Gb for English) and will take"
        echo "significant time to download and decompress.  curl resumes if interrupted."
        echo
        read -p "Continue with download [y|N]? "
        echo
        [[ $REPLY =~ ^[Yy]$ ]] || { echo "bye"; exit 1; }
    fi
    curl -I $DUMPURL 2>/dev/null | grep -q 200 || die "Error: Could not find file $DUMPURL"
    echo "Downloading ${DUMPURL##*/} to current directory"
    curl -C - -o "${FILE}.bz2" $DUMPURL || die "download failed"
}

if [ "$NEED_DUMP" == "1" ]; then
    NEED_XML="1"
    if [ -e "$FILE" ]; then
        echo "Found uncompressed dump: $FILE ($(ls -lh "$FILE" | awk '{print $5}'))"
        if [ -n "$TESTMODE" ]; then
            echo "Using it."
            NEED_XML=""
        else
            read -p "  [u]se it, [d]ecompress again from .bz2, or [r]edownload then decompress? [U/d/r] " -n 1 -r
            echo
            case "$REPLY" in
                [dD]) rm -f "$FILE";               rm -rf "./${LC}_wiki_index" ;;
                [rR]) rm -f "$FILE" "${FILE}.bz2"; rm -rf "./${LC}_wiki_index" ;;
                *)    echo "Using existing $FILE"; NEED_XML="" ;;
            esac
        fi
    fi
    if [ "$NEED_XML" == "1" ]; then
        if [ -e "${FILE}.bz2" ] && [ -z "$TESTMODE" ]; then
            echo
            echo "Found compressed dump: ${FILE}.bz2 ($(ls -lh "${FILE}.bz2" | awk '{print $5}'))"
            read -p "  [u]se it to decompress, or [r]edownload? [U/r] " -n 1 -r
            echo
            [[ $REPLY =~ ^[rR]$ ]] && rm -f "${FILE}.bz2"
        fi
        [ -e "${FILE}.bz2" ] || download
        decompress
    fi
    [ -e "$FILE" ] || die "Dump file $FILE not found. Cannot continue."
else
    echo "An existing table can serve as the source — skipping the dump download."
fi

mkdir -p ./web_server/data || die "could not create directory ./web_server/data"

# ---------------------------------------------------------------- build
echo
if [ "$BUILDTYPE" == "k" ]; then
    echo "=== Building the keyword table (wikidocs) with ${NTHREADS} threads ==="
    $RP build-wikidocs.js ${LC} ${NTHREADS} || die "wikidocs build failed"
else
    echo "=== Building the fused table (wikivecs) with ${NTHREADS} threads ==="
    echo "    model: ${ALIAS}"
    $RP build-wikivecs.js ${LC} ${ALIAS} ${NTHREADS} || die "wikivecs build failed"
fi

echo
echo "=== Building indexes ==="
$RP mkindex.js ${LC} || die "index build failed"

# Pre-fetch the reranker so the first web-server start doesn't stall on a
# ~600MB download.  Optional: without it the search still works, results
# just keep their fused (likev+likep) order.
if [ "$BUILDTYPE" == "f" ]; then
    echo
    if [ -n "$TESTMODE" ]; then
        REPLY="y"
    else
        read -p "Pre-download the reranker model (~600MB, improves result ordering)? [Y/n] " -n 1 -r
        echo
    fi
    if [[ ! $REPLY =~ ^[nN]$ ]]; then
        $RP wikilib.js reranker || echo "WARNING: reranker download failed (search will run unreranked)"
    fi
fi

# ---------------------------------------------------------------- perms
if [ "$ME" == "root" ]; then
    chown -R $WEBUSER ./web_server/data
elif [ "$ME" != "$WEBUSER" ]; then
    echo
    echo "WARNING: the database was created as user '$ME', but the webserver is set to"
    echo "         run as '$WEBUSER'.  Please check and correct the owner of the"
    echo "         '$DBDIR' directory and files therein."
fi

echo
echo "You can now start the web server like this:"
echo "  cd web_server"
echo "  ./start_wikipedia_web_server.sh"
echo
if [ "$BUILDTYPE" == "k" ]; then
    echo "The keyword search will be at:  http://localhost:8088/apps/wikipedia_search/search.html"
else
    echo "The fused search will be at:    http://localhost:8088/apps/wikipedia_search/vecsearch.html"
    echo "The keyword search (same data): http://localhost:8088/apps/wikipedia_search/search.html"
fi
echo
echo "Web server settings can be changed in the 'web_server/web_server_conf.js' file."
