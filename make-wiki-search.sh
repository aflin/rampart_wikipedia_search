#!/bin/bash

die () {
	echo $1
	exit 1
}

# Set the name of the user that web server will run under.
# This is the name of the account that will start the webserver
#   or the name set in web_server_conf.js if started as root.

WEBUSER="nobody"

RP=`which rampart`;

if [ "$RP" == "" ]; then
    die "Can't find rampart executable"
fi

ME=`whoami`

EXTRACTOR="./WikiExtractor.py"

DATADIR="./wikidata"
HAVEPV=""

curl --version &>/dev/null || die "curl must be installed and in the current \$PATH before running this script"

pv --help &>/dev/null && {
	HAVEPV="1"
} || {
	echo "WARNING: The pv util is not installed or is not in the current \$PATH.  If you wish to have a progress bar while unzipping the downloaded wikipedia file, please exit and install with e.g. \"apt install pv\""
	echo
}

echo "In order to create the wikipedia demo search, several directories will be made and the current English Wikipedia dump will be downloaded."
echo "The dump file is very large (>17Gb) and will also take significant time to unzip."
echo "The file will be downloaded using curl.  If interrupted, please run this script again and curl will attempt to resume the download."
echo "If an old version of enwiki-latest-pages-articles.xml.bz2 exists in this directory, please quit and move/delete that file first in order to download the latest dump."
echo
read -p "Continue [y|N]? " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]
then
    echo "bye"
    exit 1
fi

echo "Downloading enwiki-latest-pages-articles.xml.bz2 to current directory"
curl -C - -o enwiki-latest-pages-articles.xml.bz2 https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-pages-articles.xml.bz2 || die "download failed"

echo "Decompressing..."

check_reply () {
    echo "enwiki-latest-pages-articles.xml exists.";
    read -p "[o]verwrite or [c]ontinue with existing" -n 1 -r
    echo
}

if [ -e enwiki-latest-pages-articles.xml ]; then
    REPLY="";
    while [[ ! $REPLY  =~ ^[oO]$ ]] && [[ ! $REPLY  =~ ^[cC]$ ]]; do
       if [ "$REPLY" != "" ]; then
            echo "invalid response"
       fi
       check_reply
    done

    if [[ $REPLY =~ ^[oO]$ ]]; then
	echo
        if [ "$HAVEPV" == "1" ] ; then
                # we need to cat the file since it is too large for bzcat on a 32bit system.
                cat enwiki-latest-pages-articles.xml.bz2 | pv -s $(ls -l enwiki-latest-pages-articles.xml.bz2 | awk '{print $5}') | bzcat -d > enwiki-latest-pages-articles.xml || die "Failed to decompress file"
        else
                cat enwiki-latest-pages-articles.xml.bz2 | bzcat -d > enwiki-latest-pages-articles.xml || die "Failed to decompress file"
        fi
    fi
else
    if [ "$HAVEPV" == "1" ] ; then
            cat enwiki-latest-pages-articles.xml.bz2 | pv -s $(du -sb enwiki-latest-pages-articles.xml.bz2 | awk '{print $1}') | bzcat -d > enwiki-latest-pages-articles.xml || die "Failed to decompress file"
    else
            cat enwiki-latest-pages-articles.xml.bz2 | bzcat -d > enwiki-latest-pages-articles.xml || die "Failed to decompress file"
    fi
fi

check_datadir () {
    if [ -e $DATADIR/txt/AA ] ; then 
        echo "There appears to be text already extracted in the $DATADIR/txt directory"
        echo "Should we overwrite that data and start again or use the data already present?"
        read -p "[o]verwrite or [c]ontinue with existing" -n 1 -r
        echo
    fi
}

REPLY="";
while [[ ! $REPLY  =~ ^[oO]$ ]] && [[ ! $REPLY  =~ ^[cC]$ ]]; do
   if [ "$REPLY" != "" ]; then
        echo "invalid response"
   fi
   check_datadir
done

if [[ $REPLY =~ ^[oO]$ ]]; then
    echo "removing content in $DATADIR/txt/" 
    rm -rf $DATADIR/txt/*
    REPLY="";
fi

if [[ $REPLY =~ ^[Cc]$ ]]; then
    echo "Extracting text from enwiki-latest-pages-articles.xml"

    mkdir -p "$DATADIR/txt" || die "could not make directory $DATADIR/txt"

    #./WikiExtractor.py -o "$DATADIR/txt" enwiki-latest-pages-articles.xml|| die "failed to extract text from enwiki-latest-pages-articles.xml"
    ./WikiExtractor.py -o "$DATADIR/txt" enwiki-latest-pages-articles.xml 2>&1 | tee extractor-output.txt | while read i; do 
        line=$(echo -n $i | grep -oE '[[:digit:]]+.+'); 
        printf "%s            \r" "$line"; 
    done || die "failed to extract text from enwiki-latest-pages-articles.xml"
fi

if [ ! -e ./web_server/data ]; then
    mkdir -p ./web_server/data || die "could not create directory ./web_server/data"
fi


echo "importing data"
$RP import.js
echo "creating text index"
$RP mkindex.js

if [ "$ME" == "root" ]; then
    chown -R nobody ./web_server/data
fi

if [ "$ME" != "$WEBUSER" ] ;
    echo "WARNING: the database was created as user '$ME', but the webserver is set to be";
    echo "         run as '$WEBUSER'.  Please check and correct the owner of the "
    echo "         './web_server/data/wikipedia_search/' directory and files therein."


#echo "Now you can run \"rampart import.js\" and \"rampart mkindex.js\" to create the database."
#echo "After it is made, \"rampart wksearch.js\" will start the server"

