#!/bin/bash

die () {
	echo $1
	exit 1
}

# the full english wikipedia dump
FILE="enwiki-latest-pages-articles.xml"
DUMPURL="https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-pages-articles.xml.bz2"

# or a smaller file for testing.  This file will likely disappear in a few months.
# but you can find a small one manually by navigating https://dumps.wikimedia.org/enwiki/latest/
#DUMPURL="https://dumps.wikimedia.org/enwiki/20220220/enwiki-20220220-pages-articles11.xml-p6899367p7054859.bz2"

# Set the name of the user that web server will run under.
# This is the name of the account that will start the webserver
#   or the name set in web_server_conf.js if started as root.
WEBUSER="nobody"

RP=`which rampart`;

if [ "$RP" == "" ]; then
    die "Can't find rampart executable"
fi

ME=`whoami`

HAVEPV=""

curl --version &>/dev/null || die "curl must be installed and in the current \$PATH before running this script"

pv --help &>/dev/null && {
	HAVEPV="1"
} || {
	echo "WARNING: The pv util is not installed or is not in the current \$PATH.  If you wish to have a progress bar while unzipping the downloaded wikipedia file, please exit and install with e.g. \"apt install pv\""
	echo
}

# TEST MODE: build from the small, complete Simple-English Wikipedia dump
# (~350MB vs >17GB for full English) so the whole flow can be exercised in
# minutes instead of days. Runs non-interactively. Trigger with:
#     ./make-wiki-search.sh test      (or)   WPTEST=1 ./make-wiki-search.sh
TESTMODE=""
if [ "$1" == "test" ] || [ "$WPTEST" == "1" ]; then
    TESTMODE="1"
    LC="simple"
    FILE="simplewiki-latest-pages-articles.xml"
    DUMPURL="https://dumps.wikimedia.org/simplewiki/latest/simplewiki-latest-pages-articles.xml.bz2"
    echo "*** TEST MODE: Simple English Wikipedia (${DUMPURL##*/}, ~350MB) -> ${LC}_wikipedia_search ***"
    echo
fi

if [ -z "$TESTMODE" ]; then
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
LMDBIDX="./${LC}_wiki_index"   # page index built by import.js from the dump

# decompress ${FILE}.bz2 -> ${FILE}
decompress () {
    echo "Decompressing ${FILE}.bz2 ..."
    if [ "$HAVEPV" == "1" ]; then
        cat "${FILE}.bz2" | pv -s $(ls -l "${FILE}.bz2" | awk '{print $5}') | bzcat -d > "$FILE" || die "Failed to decompress file"
    else
        cat "${FILE}.bz2" | bzcat -d > "$FILE" || die "Failed to decompress file"
    fi
}

# download the dump (curl resumes if interrupted)
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

# ---- 1) Database: if it exists, offer to drop & rebuild, or keep (skip to vectors) ----
SKIP_TEXT=""
if [ -e "$DBDIR" ]; then
    echo
    echo "Database already exists: $DBDIR"
    read -p "  [d]rop and rebuild, or [k]eep it and skip to the vector build? [d/K] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[dD]$ ]]; then
        echo "Dropping database $DBDIR"
        rm -rf "$DBDIR"
    else
        echo "Keeping existing text database; continuing to the vector build."
        SKIP_TEXT="1"
    fi
fi

# ===== TEXT BUILD (download -> decompress -> import -> index) — skipped if keeping DB =====
if [ -z "$SKIP_TEXT" ]; then

# ---- 2) Uncompressed dump: use it, decompress again, or redownload ----
NEED_XML="1"
if [ -e "$FILE" ]; then
    echo
    echo "Found uncompressed dump: $FILE ($(ls -lh "$FILE" | awk '{print $5}'))"
    read -p "  [u]se it, [d]ecompress again from .bz2, or [r]edownload then decompress? [U/d/r] " -n 1 -r
    echo
    case "$REPLY" in
        [dD]) rm -f "$FILE";              rm -rf "$LMDBIDX" ;;  # rebuild xml (+ force re-scan)
        [rR]) rm -f "$FILE" "${FILE}.bz2"; rm -rf "$LMDBIDX" ;;
        *)    echo "Using existing $FILE"; NEED_XML="" ;;       # keep xml as-is
    esac
fi

# ---- 3) Compressed file: only needed if we still must produce the xml ----
if [ "$NEED_XML" == "1" ]; then
    if [ -e "${FILE}.bz2" ]; then
        echo
        echo "Found compressed dump: ${FILE}.bz2 ($(ls -lh "${FILE}.bz2" | awk '{print $5}'))"
        read -p "  [u]se it to decompress, or [r]edownload? [U/r] " -n 1 -r
        echo
        [[ $REPLY =~ ^[rR]$ ]] && rm -f "${FILE}.bz2"
    fi
    [ -e "${FILE}.bz2" ] || download
    decompress
fi

if [ ! -e "$FILE" ]; then
    die "Dump file $FILE not found. Cannot continue."
fi

if [ ! -e ./web_server/data ]; then
    mkdir -p ./web_server/data || die "could not create directory ./web_server/data"
fi

echo "Scanning, expanding, and importing articles from ${FILE}"
echo "This uses the wikiparser module to expand templates and extract text."
echo

IMPORT_SCRIPT="import-multithread.js"
if [ -z "$TESTMODE" ]; then
    IMPORT_SCRIPT="import.js"
    read -p "Use parallel import (multiple CPUs)? [Y|n] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[nN]$ ]]; then
        IMPORT_SCRIPT="import-multithread.js"
    fi
fi

$RP $IMPORT_SCRIPT ${LC} && {
    echo "creating text index"
    $RP mkindex.js ${LC}
} || die "Import and index creation were aborted."

if [ "$ME" == "root" ]; then
    chown -R $WEBUSER ./web_server/data
elif [ "$ME" != "$WEBUSER" ] ; then
    echo "WARNING: the database was created as user '$ME', but the webserver is set to be";
    echo "         run as '$WEBUSER'.  Please check and correct the owner of the "
    echo "         './web_server/data/wikipedia_search/' directory and files therein."
fi

fi   # ===== end TEXT BUILD (skipped when keeping an existing database) =====

# Offer to build the semantic (vector) search now.  build-wikivecs.js embeds the
# article chunks and builds the likev/likep indexes (via mkvecsindex.js), and
# downloads the embed model into ~/.rampart/models/embed/ if it isn't present.
echo
read -p "Build the semantic (vector) search now? (downloads the embed model if needed) [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "Use parallel (multi-threaded) embedding? (faster) [Y/n] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[nN]$ ]]; then
        $RP build-wikivecs.js ${LC} || die "semantic build failed"
    else
        # Default to one worker per core, capped at 10 (more just thrashes the
        # disk on CPU and gains little).
        NCORES=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 4)
        DEFTHREADS=$NCORES
        [ "$DEFTHREADS" -gt 10 ] && DEFTHREADS=10
        echo
        echo "Number of embedding worker threads."
        echo "  Each worker runs its own model context.  The default (one per core,"
        echo "  capped at 10) is plenty -- a handful of threads already saturate the"
        echo "  GPU, so more give diminishing returns.  Raise it only if the GPU is"
        echo "  not fully utilized."
        read -p "Worker threads [default ${DEFTHREADS}]: " NTHREADS
        echo
        case "$NTHREADS" in
            "")          NTHREADS=$DEFTHREADS ;;
            *[!0-9]*|0)  echo "Invalid count '$NTHREADS'; using ${DEFTHREADS}."; NTHREADS=$DEFTHREADS ;;
        esac
        $RP build-wikivecs-multithread.js ${LC} ${NTHREADS} || die "semantic build failed"
    fi
else
    echo "Build it later with:  $RP build-wikivecs-multithread.js ${LC} [threads]   (or build-wikivecs.js for single-threaded)"
fi

echo
echo "You can now start the web server like this:"
echo "  cd web_server"
echo "  ./start_wikipedia_web_server.sh"
echo
echo "Web server settings can be changed in the 'web_server/web_server_conf.js' file."

if [ "$TESTMODE" == "1" ]; then
    echo
    echo "TEST MODE built the '${LC}_wikipedia_search' database."
    echo "(the web server config currently points at 'en_wikipedia_search' - aim it at"
    echo " '${LC}_wikipedia_search' to serve the test build.)"
fi
