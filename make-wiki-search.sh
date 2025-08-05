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

EXTRACTOR="./WikiExtractor.py"

DATADIR="./en_wikidata"
HAVEPV=""

curl --version &>/dev/null || die "curl must be installed and in the current \$PATH before running this script"

pv --help &>/dev/null && {
	HAVEPV="1"
} || {
	echo "WARNING: The pv util is not installed or is not in the current \$PATH.  If you wish to have a progress bar while unzipping the downloaded wikipedia file, please exit and install with e.g. \"apt install pv\""
	echo
}

echo "In order to create the wikipedia demo search, several directories will be made and the current Wikipedia dump will be downloaded."
echo "The English dump file is very large (>17Gb), as are others, and will also take significant time to unzip."
echo "The file will be downloaded using curl.  If interrupted, please run this script again and curl will attempt to resume the download."
echo "If an old version of enwiki-latest-pages-articles.xml.bz2 exists in this directory, please quit and move/delete that file first in order to download the latest dump."

read -p "Continue [y|N]? "
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]
then
    echo "bye"
    exit 1
fi

echo "Which Wikipedia dump would you like to download?"
echo "  Use language code es for Spanish, en for English, de for German, fr for French, etc."
echo
read -p "Lang code (enter for English): " LC

if [ "$LC" == "" ]; then
    LC="en"
else
    FILE="${LC}wiki-latest-pages-articles.xml"
    DUMPURL="https://dumps.wikimedia.org/${LC}wiki/latest/${LC}wiki-latest-pages-articles.xml.bz2"
    DATADIR="./${LC}_wikidata"

fi

curl -I $DUMPURL | grep -q 200 || die "Error: Could not find file $DUMPURL"

echo "Downloading ${LC}wiki-latest-pages-articles.xml.bz2 to current directory"
curl -C - -o "${FILE}.bz2" $DUMPURL || die "download failed"

echo "Decompressing..."

if [ -e "$FILE" ]; then
    REPLY="";
    while [[ ! $REPLY  =~ ^[oO]$ ]] && [[ ! $REPLY  =~ ^[cC]$ ]]; do
       if [ "$REPLY" != "" ]; then
            echo "invalid response"
       fi
       echo "$FILE exists.";
       read -p "[o]verwrite or [c]ontinue with existing" -n 1 -r
       echo
    done

    if [[ $REPLY =~ ^[oO]$ ]]; then
	echo
        if [ "$HAVEPV" == "1" ] ; then
                # we need to cat the file since it is too large for bzcat on a 32bit system.
                cat "${FILE}.bz2" | pv -s $(ls -l "$FILE" | awk '{print $5}') | bzcat -d > "$FILE" || die "Failed to decompress file"
        else
                cat "$FILE.bz2" | bzcat -d > "$FILE" || die "Failed to decompress file"
        fi
    fi
else
    if [ "$HAVEPV" == "1" ] ; then
            cat "${FILE}.bz2" | pv -s $(du -sb "${FILE}.bz2" | awk '{print $1}') | bzcat -d > "${FILE}" || die "Failed to decompress file"
    else
            cat "${FILE}.bz2" | bzcat -d > "${FILE}" || die "Failed to decompress file"
    fi
fi

REPLY="";
if [ -e $DATADIR/txt/AA ] ; then
    while [[ ! $REPLY  =~ ^[oO]$ ]] && [[ ! $REPLY  =~ ^[cC]$ ]]; do
       if [ "$REPLY" != "" ]; then
            echo "invalid response"
       fi
       echo "There appears to be text already extracted in the $DATADIR/txt directory"
       echo "Should we overwrite that data and start again or use the data already present?"
       read -p "[o]verwrite or [c]ontinue with existing" -n 1 -r
       echo
    done
fi

if [[ $REPLY =~ ^[oO]$ ]]; then
    echo "removing content in $DATADIR/txt/" 
    rm -rf $DATADIR/txt/*
    REPLY="";
fi

if [ "$REPLY" = "" ]; then
    echo "Extracting text from ${FILE}"

    mkdir -p "$DATADIR/txt" || die "could not make directory $DATADIR/txt"

    #./WikiExtractor.py -o "$DATADIR/txt" "${FILE}"|| die "failed to extract text from "${FILE}""
    ./WikiExtractor.py -o "$DATADIR/txt" "${FILE}" 2>&1 | tee extractor-output.txt | while read i; do 
        line=$(echo -n $i | grep -oE '[[:digit:]]+.+'); 
        printf "%s            \r" "$line"; 
    done || die "failed to extract text from "${FILE}""
fi

if [ ! -e ./web_server/data ]; then
    mkdir -p ./web_server/data || die "could not create directory ./web_server/data"
fi


echo "importing data"
$RP import.js ${LC} && {
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

echo "You can now start the web server like this:"
echo "  cd web_server"
echo "  ./start_wikipedia_web_server.sh"
echo
echo "Web server settings can be changed in the 'web_server/web_server_conf.js' file."
