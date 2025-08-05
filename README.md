# rampart_wikipedia_search
A demo full text search of Wikipedia (in one or several languages of your choice) using the Rampart SQL module on Linux or MacOs.  The search is powerful and efficient enough to be run on hardware as small as a Raspberry Pi Zero.

## Usage:
Running ``./make_wiki-search.sh`` will initiate the build. It will ask for the version (such as 'en' or 'de') and can be run multiple times with different languages. The script will provide some information and then:

1. Download the latest wikipedia dump from dumps.wikipedia.org for the chosen language.
2. Decompress the downloaded file.
3. Execute WikiExtractor.py to extract the text from the decompressed wikitext file.
4. Import the data using import.js.
5. Create the index using mkindex.js

## Required tools:

1. [Rampart JavaScript](https://github.com/aflin/rampart)
2. Python2
3. Curl
4. bzcat (part of the bzip2 package)
5. pv (optional to display a progress bar while decompressing)

After one or more search databases are built, the webserver may be started in the 'web_server'
directory with ``./start_wikipedia_web_server.sh``.

## Demo:

An English demo running on the Raspberry Pi Zero can be found [here](https://rampart.dev/apps/site/run_demo.html?demo=wikipedia).
