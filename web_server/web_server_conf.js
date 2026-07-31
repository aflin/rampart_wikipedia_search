#!/usr/bin/env rampart

/*
the server can be started by running:
  rampart web_server_conf.js
         or
  rampart web_server_conf.js start

Help:
  ./web_server_conf.js help
  usage:
    rampart web_server_conf.js [start|stop|restart|letssetup|status|dump|help]
        start     -- start the http(s) server
        stop      -- stop the http(s) server
        restart   -- stop and restart the http(s) server
        letssetup -- start http only to allow letsencrypt verification
        status    -- show status of server processes
        dump      -- dump the config object used for server.start()
        help      -- show this message
*/

//set working directory to the location of this script
var working_directory = process.scriptPath;

/* ***********************  SEMANTIC SEARCH ADDITIONS ********************** */

/* The fused search (vecsearch.js) needs two things beyond the database:

   1. QUERY EMBEDDING — per-language, configured by the model.json that
      build-wikivecs.js wrote into each <lc>_wikipedia_search directory.
      vecsearch.js handles that itself (one sql connection per language,
      each set to the model+engine that built its table).

   2. THE RERANKER — one bge-reranker-v2-m3 cross-encoder handle, shared
      by every server thread.  wikilib resolves it through rampart-models
      (the ~/.rampart store), the same way the embedding models resolve.
      Loaded here AFTER the fork (CUDA does not
      survive forking) and copied to the workers as the global 'rr'.
      If the model or module is missing, reranking is simply disabled and
      results keep their fused (likev + likep) order. */

var wikilib = require(working_directory + "/../wikilib.js");

function init_langtools() {
    var g = global;
    /* only load the reranker when a fused database exists */
    var data = rampart.utils.readDir(working_directory + "/data") || [];
    var haveVecs = false;
    for (var i = 0; i < data.length; i++) {
        if (/_wikipedia_search$/.test(data[i]) &&
            rampart.utils.stat(working_directory + "/data/" + data[i] + "/wikivecs.tbl")) {
            haveVecs = true;
            break;
        }
    }
    if (!haveVecs) return;
    g.rr = wikilib.initReranker();
}

/* ******************* END  SEMANTIC SEARCH ADDITIONS ********************** */


/* ****************************************************** *
 *  UNCOMMENT AND CHANGE DEFAULTS BELOW TO CONFIG SERVER  *
 * ****************************************************** */

var serverConf = {

    preThreadFunc: init_langtools,

    //the defaults for full server

    /* ipAddr              String. The ipv4 address to bind   */
    //ipAddr:              '127.0.0.1',

    /* ipv6Addr            String. The ipv6 address to bind   */
    //ipv6Addr:            '[::1]',

    /* bindAll             Bool.   Set ipAddr and ipv6Addr to 0.0.0.0 and [::] respectively   */
    //bindAll:             false,

    /* htmlRoot            String. Root directory from which to serve files   */
    //htmlRoot:            working_directory + '/html',

    /* appsRoot            String. Root directory from which to serve apps   */
    //appsRoot:            working_directory + '/apps',

    /* wsappsRoot          String. Root directory from which to serve websocket apps   */
    //wsappsRoot:          working_directory + '/wsapps',

    /* dataRoot            String. Setting for user scripts   */
    //dataRoot:            working_directory + '/data',

    /* logRoot             String. Log directory   */
    //logRoot:             working_directory + '/logs',

    /* accessLog           String. Log file name or null for stdout  */
    //accessLog:           working_directory + '/logs/access.log',

    /* errorLog            String. error log file name or null for stderr*/
    //errorLog:            working_directory + '/logs/error.log',

    /* log                 Bool.   Whether to log requests and errors   */
    //log:                 true,

    /* user                String. If started as root, switch to this user
                                   It is necessary to start as root if using ports < 1024   */
    //user:                'nobody',

    /* threads             Number. Limit the number of threads used by the server.
                                   Default (-1) is the number of cores on the system   */
    //threads:             -1,

    /* secure              Bool.   Whether to use https.  If true sslKeyFile and sslCertFile must be set   */
    //secure:              false,

    /* sslKeyFile          String. If https, the ssl/tls key file location   */
    //sslKeyFile:          '',

    /* sslCertFile         String. If https, the ssl/tls cert file location   */
    //sslCertFile:         '',

    /* developerMode       Bool.   Whether JavaScript errors result in 500 and return a stack trace.
                                   Otherwise errors return 404 Not Found                             */
    //developerMode:       true,

    /* letsencrypt         String. If using letsencrypt, the 'domain.tld' name for automatic setup of https   */
    //letsencrypt:         "",

    /* directoryFunc       Bool.   Whether to provide a directory listing if no index.html is found   */
    //directoryFunc:       false,

    /* daemon              Bool.   whether to detach from terminal and run as a daemon  */
    //daemon:              true,

    /* monitor             Bool.   whether to launch monitor process to auto restart server if
                                   killed or unrecoverable error */
    //monitor:             false,

    /* scriptTimeout       Number. Max time to wait for a script module to return a reply in seconds (default 20) */
    //scriptTimeout:       20,

    /* connectTimeout      Number. Max time to wait for client send request in seconds (default 20)   */
    //connectTimeout:      20,

    serverRoot:            working_directory,
}

// If not forking, run the langtools init here.
// Otherwise it is run automatically after fork and 
// privelege drop, and before server threads are created.
if (serverConf.daemon === false)
    init_langtools();

/* **************************************************** *
 *  process command line options and start/stop server  *
 * **************************************************** */
require("rampart-webserver").web_server_conf(serverConf);
