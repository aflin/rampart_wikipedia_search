# rampart_wikipedia_search
A demo full text search of English Wikipedia using the Rampart SQL module on Linux or MacOs.  The search is powerful and efficient enough to be run on hardware as small as a Raspberry Pi Zero.

## Usage:
Running ``./make_wiki-search.sh`` will initiate the build.  The script will provide some information and then:

1. Download the latest wikipedia dump from dumps.wikipedia.org.
2. Decompress the downloaded file.
3. Execute WikiExtractor.py to extract the text from the decompressed wikitext file.
4. Import the data using import.js.
5. Create the index using mkindex.js

## Required tools:

1. Python2
2. Curl
3. bzcat (part of the bzip2 package)
4. pv (optional to display a progress bar while decompressing)

After the search is build, the webserver may be started with ``rampart ./wksearch.js``.

## Demo:

A demo running on the Raspberry Pi Zero can be found [here](https://rampart.dev/wikipedia_search/).
