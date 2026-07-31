#!/bin/bash

cd "$(dirname "$0")" || exit 1

die() {
    echo "$1"
    exit 1
}

RP=`which rampart`
[ -z "$RP" ] && die "Cannot find rampart executable in your path"

ls ./data/*_wikipedia_search &>/dev/null || die "No ./data/<lang>_wikipedia_search database found.  Build one with ../make-wiki-search.sh first."

$RP ./web_server_conf.js
