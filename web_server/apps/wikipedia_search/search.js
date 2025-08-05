/* The Wikipedia Demo Search Module

   Everything outside the 'search()' function below is run once (per thread) when
   the module is loaded.  The 'module.exports=search` is the exported function
   which is run once per client request.

   Note that this means that variables set outside the 'search()' function are 
   long lived and span multiple requests by potentially multiple clients.  As
   such, care should be taken that these variables do not include any information
   which should not be shared between clients.
*/

// Load the sql module.  This only needs to be done once
var Sql=require("rampart-sql");

// process.scriptPath is the path of the web_server_conf.js, not
// the path of this module script. For the path of this module, 
// use 'module.path'.
var db=serverConf.dataRoot + '/en_wikipedia_search';

// Open the db.
//var sql=new Sql.init(db);

// object for muliple dbs
var sqlo={};

// wiki names by lang code
var langdata=loadlangdata();

// make printf = rampart.utils.printf
// See: https://rampart.dev/docs/rampart-main.html#rampart-globalize
rampart.globalize(rampart.utils);
var dblist={};
/* 
Example of some settings to modify search weights which can be used to use
to tune the search results.  These values are just examples and are not
tuned for this search.
See: https://rampart.dev/docs/sql-set.html#rank-knobs
and  https://rampart.dev/docs/sql-set.html#other-ranking-properties
    sql.set({
        "likepallmatch":false,
        "likepleadbias":250,
        "likepproximity":750,
        "likeprows":2000,
    });

One example of effecting a behavioral change:

    The following will push e.g.  "V8(beverage)" higher in the results when
    searching for "v8" by increasing the importance of "v8" occurring at the
    beginning of the document.

        sql.set({ "likepleadbias":750 }); //possible values: 0-1000 with default of 500

NOTE ALSO:  
     Here the 'sql' variable is set when the module is loaded.  Any changes
     made in 'search()' below using sql.set() will be carried forward for
     the next client (per server thread).  If you have settings (as set in
     'sql.set()') that change per request or per client, it is highly
     advisable that you call 'sql.reset()' at the beginning of the exported
     'search()' function below followed by a `sql.set()` call to make the
     behavioral changes desired.
     
     If the sql.set() call is intended for every client and every search,
     setting it here is not problematic.
*/

//sql.set({ "likepleadbias":750 });

/* 
 the top section of html only needs to be set once as it remains the same
 regardless of the request.  Here it is set when the module is first loaded. 
 This is a printf style format string so that the query text box may be
 filled if, e.g., ?q=v8 is set.

 The sprintf(%w', format_string): 
    This removes leading white space so it can be pretty 
    here in the source but compact when sent. 
    See https://rampart.dev/docs/rampart-utils.html#printf
*/
var htmltop_format=sprintf('%w',
`<!DOCTYPE HTML>
    <html><head><meta charset="utf-8">
    <style>
        body {font-family: arial,sans-serif;}
        td {position:relative;}
        #showrm {position:relative;}
        .itemwrap{ width: calc( 100%% - 70px); position: relative;display: inline-block;}
        .owrap {width:100%%;float: left; display:inline-block;position:relative;padding-top:5px;}
        .abs { margin-right:5px;white-space: normal;}
        .urlsp {color:#006621;max-width:100%%;overflow: hidden;text-overflow: ellipsis;white-space:nowrap;display:inline-block;font-size:.90em;}
        .urla {text-decoration: none;font-size:16px;overflow: hidden;text-overflow: ellipsis;white-space:nowrap;display:inline-block; width: 100%%; }
        .b { font-size: 18px; margin-left:4px; }
        #res {font-size:12px;padding:15px 10px 0px 0px;}
        #setbox {position:relative; padding:10px; margin:10px; background-color:#eee; border: 1px dotted gray; top:0px; left:0px;}
        #setbox td {white-space:nowrap;}
        .sall{ cursor: pointer;position: absolute;left: -15px;top: 0px;}
        .ib { display: inline-block; }
        .rm {display:none; top:24px; position:absolute; font-size: 15px;width: 12px;text-align: center;cursor:pointer; font-weight: bold;}
        .res {margin-top: 80px;}
        .resi {min-height:20px;position:relative;clear:both;padding-top: 15px;}
        .nw { white-space:nowrap;}
        .submit{height:30px; border:none; position:absolute; right:0px; width:50px;}
    </style>
    <script>
document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('langc').addEventListener('change', function(e) {
      var selected = e.target.options[e.target.selectedIndex];
      var sb = document.getElementById('subbut');
      var fq = document.getElementById('fq');
      if (selected.classList.contains('rtl')) {
        sb.style.left = '0px';
        fq.style.direction='rtl';
      } else {
        sb.style.left = '';
        fq.style.direction='ltr';
      }
    });
});
    </script>
    </head><body>
    <div id="lc" style="background-color: white; position: fixed; left:0px; top:0px; min-height: 300px; overflow-x: hidden; padding-right: 20px; padding-left: 20px; box-sizing: border-box; width: 200px;">
     <div style="width:180px;height:128px;margin-bottom:15px"><img src="data:image/jpeg;base64,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" style="width:145px;height:108px;padding-left:16px;margin-top:10px">
      【ＲａｍｐａｒｔＤＢ】</div>
    </div>
    <div id="main" style="padding-bottom:30px;background-color: white; position: absolute; left:200px; top:0px; min-height: 300px; overflow-x: hidden; padding-right: 20px; padding-left: 30px; box-sizing: border-box; width: 600px;">
      <form id="mf" action="/apps/wikipedia_search/search.html">
        <div style="width:100%%">
          <span style="white-space:nowrap;display:block;width:550px;height:50px;position:fixed;background-color: white;z-index:10;border-bottom: lightGray 1px solid; padding-top:15px;padding-bottom:15px">
            <div class="wtitle">%s</div>
            <table style="background-color: white; width:100%%">
              <tr>
                <td style="position:relative">
                  <input autocomplete="off" type="text" id="fq" name="q" value="%H" placeholder="Search" style="box-sizing:border-box;%smin-width:150px;width:100%%;height:30px;font:normal 18px arial,sans-serif;padding: 1px 3px;border: 2px solid #ccc;">
                  <input id="subbut" style="%s" class="submit" type="submit" value="search">
                </td>
              </tr>
            </table>
          </span>
        </div>
      </form>
      <div class="res">`
);


function getdblist() {
    var res = readDir(serverConf.dataRoot);
    var i=0;
    var ret={};

    for(;i<res.length;i++) {
        var entry = res[i];
        var parts = entry.match(/([^_]+)_wikipedia_search/);
        if(parts && parts.length>1) {
            ret[parts[1]]=parts[0];
        }
    }
    return ret;
}

function missingdb(lc) {
    return { html:
`
<!doctype html>
<html><head><title>Missing Database</title><meta charset="utf-8"></head><body>
<h3>The database with code "${lc}" ${langdata[lc]? ( '('+langdata[lc].english+' / '+langdata[lc].native+')' ) : ''} could not be found</h3>
${langdata[lc]?'<br><span>Try running <code style="color:green">make_wiki_search</code> from the main distribution directory and enter <code style="color:green">'+lc+'</code> when prompted for a language code':''}
</body></html>
`};
}

function search(req) {
    var params = req.params;
    var q=params.q ? params.q: "";
    var lc = params.lc ? params.lc: 'en';

    // req.query.skip in, e.g. "/apps/wikipedia_search/search.html?q=v8&skip=10" is text.
    // Make it a JavaScript number.
    var skip=parseInt( params.skip );

    var icount=0;  //estimated total number of results, set below
    var endhtml;   // closing tags, set below
    var nres=10;   // number of results per page
    var ld = langdata[lc];

    var sql = sqlo[lc];
    if(!sql) {
        dblist=getdblist();

        if(!dblist[lc])
            return missingdb(lc);

        db=serverConf.dataRoot + `/${lc}_wikipedia_search`;
        try {
            sqlo[lc]=Sql.connect(db);
        } catch(e){
            return missingdb(lc);
        }
        sql = sqlo[lc];
    }

    var sellst = '<select id="langc" name="lc">'
    for (var key in dblist) {
        if(langdata[key]) {
            sellst += `<option ${langdata[key].rtl?'class="rtl" ':''}${(key==lc)?'SELECTED ':''}value="${key}">${langdata[key].english+' / ' + langdata[key].native}</option>`;
        }
    }
    sellst+='</select>';


    // add the htmltop text to the server's output buffer.
    // See: https://rampart.dev/docs/rampart-server.html#req-printf
    // it includes escaped '%%' values and the 'value="%H"' format code for the query
    req.printf(htmltop_format, sellst, q, (ld.rtl ? 'direction:rtl;' : 'direction:ltr;'), (ld.rtl ? 'left:0px;' : '') );

    if (!skip)skip=0;

    // if there is a query, search for it and format the results.
    // if not, just send the endhtml.
    if(q) {
        // by default, only the first 100 rows are returned for any likep search.
        // if we are skipping past that, we need to raise the likeprows setting.
        if(skip + nres > 100 )
            sql.set({likeprows:skip + nres});
        else
            sql.set({likeprows:100}); //reset to default in case previously set

//        try {
            sql.set({useDerivations: lc});
//        } catch(e) {};

        sql.exec(
            /* The SQL statement:
           
               %mbH in stringformat() means highlight with bold and html escape. 
               See: https://rampart.dev/docs/rampart-sql.html#metamorph-hit-mark-up
                    https://rampart.dev/docs/sql-server-funcs.html#stringformat

               "@0 " is added to the abstract query to allow partial matches to be
               highlighted (i.e.  if a two word query, but only one word is in the
               abstract).  
               See https://docs.thunderstone.com/site/texisman/specifying_no_intersections_or.html

               abstract(text[, maxsize[, style[, query]]]) will create an abstract:  
                  - Doc is the table field from which to create an abstract.
                  - 0 (or <0) means use the default maximum size of 230 characters.
                  - 'querymultiple' is a style which will break up the abstract into multiple sections if necessary
                  - '?' is replaced with the JavaScript variable 'q'
            */
            "select Id, Title, stringformat('%mbH','@0 '+?,abstract(Doc,0,'querymultiple',?)) Ab from wikitext where Doc likep ?",

            // the parameters for each '?' in the above statement
            [q,q,q],

            // options
            {maxRows:nres,skipRows:skip,includeCounts:true},

            // callback is executed once per retrieved row.
            function(res,i,cols,info) {
                /* res = {Id: xxx, Title:"yyy", Ab:"zzz"}
                 * i = current row, beginning at skip, ending at or before skip + nres
                 * cols = ["Id", "Title", "Ab"] - the columns returned from the SQL statement
                 * includeCounts sets info to an object detailing the number of possible matches to a "likep" query. */

                //the first row
                if(i==skip) {
                    icount=parseInt(info.indexCount);
                    req.printf('<div class="info">Results %d-%d of about %d</div>',skip+1,(skip+nres>icount)?icount:skip+nres,icount);
                }

                // format each row and add to the HTML in the server buffer to be sent to client
                var rtltxt=""; 
                if(ld.rtl)
                    rtltxt=' dir="rtl"'
                    req.printf('<div class="resi" style="padding-top: 15px;"%s>'+
                                    '<span class="owrap">'+
                                    '<span class="itemwrap">'+
                                        '<span class="abs nw">'+
                                          '<a class="urla tar" target="_blank" href="https://'+lc+'.wikipedia.org/wiki?curid=%i">%s<br>'+
                                          '<span class="abs urlsp snip">https://'+lc+'.wikipedia.org/wiki?curid=%i</span></a>'+
                                        '</span>'+
                                        '<span class="abs snip"><br>%s</span>'+
                                  '</span></span></div>'
                    ,rtltxt, res.Id,res.Title,res.Id,res.Ab); 
            }
        );
    }

    // check if there are more rows.  If so, print a 'next' link.
    if (icount > nres+skip) {
        skip+=nres
        // %U is for url encoding.  See https://rampart.dev/docs/rampart-utils.html#printf
        endhtml=sprintf('</div><br><div style="text-align:right;padding-top: 12px;width: 450px;clear: both;"><a href="/apps/wikipedia_search/search.html?q=%U&lc=%s&skip=%d">Next %d</a></div></body></html>',
                req.query.q, lc, skip,nres);
    } else {
        endhtml='</div></div></body></html>';
    }

    // send the closing html and set the  mime-type to text/html
    // This is appended to everything already sent using req.printf()
    return({html:endhtml});

    // alternatively, it might be sent like this:
//    req.put(endhtml);
//    return({html:null}); //null means just set the mime-type, but don't append

}

//export the main search function
module.exports=search;

/* 
after doing:
    wget https://en.wikipedia.org/wiki/List_of_Wikipedias
do something like this:
rampart.globalize(rampart.utils);

var html = require('rampart-html');

var doc = html.newDocument(readFile('List_of_Wikipedias'));

var tbl = doc.findClass("wikitable").findTag('tbody');
var rows = tbl.findTag('tr');

var i;

var obj={};
for (i=1;i<rows.length; i++) {
    var row = rows.eq(i);
    var cells = row.children();
    var lc = cells.eq(4).toText()[0].trim();
    var enname = cells.eq(0).toText()[0].trim();
    var naname = cells.eq(1).children().toHtml()[0];
    if(/(deleted|closed)/.test(lc))
        continue;
    obj[lc]={
        "english":enname,
        "native": naname
    }
    if(/"rtl"/.test(naname))
        obj[lc].rtl=true;
}

printf("%4J\n", obj);

*/

// the names plus whether rtl
// many are not yet supported if they do not have spaces between words (e.g. Japanese)
function loadlangdata() {
    return {
    "en": {
        "english": "English Wikipedia",
        "native": "<span>English Wikipedia</span>"
    },
    "de": {
        "english": "German Wikipedia",
        "native": "<span title=\"German-language text\"><span lang=\"de\">Deutschsprachige Wikipedia</span></span>"
    },
    "fr": {
        "english": "French Wikipedia",
        "native": "<span title=\"French-language text\"><span lang=\"fr\">Wikipédia en français</span></span>"
    },
    "ja": {
        "english": "Japanese Wikipedia",
        "native": "<span title=\"Japanese-language text\"><span lang=\"ja\">ウィキペディア日本語版</span></span>"
    },
    "zh": {
        "english": "Chinese Wikipedia",
        "native": "<a href=\"/wiki/Traditional_Chinese_characters\" title=\"Traditional Chinese characters\">Traditional Chinese</a>"
    },
    "es": {
        "english": "Spanish Wikipedia",
        "native": "<span title=\"Spanish-language text\"><span lang=\"es\">Wikipedia en español</span></span>"
    },
    "pl": {
        "english": "Polish Wikipedia",
        "native": "<span title=\"Polish-language text\"><span lang=\"pl\">Polskojęzyczna Wikipedia</span></span>"
    },
    "fa": {
        "english": "Persian Wikipedia",
        "native": "<span title=\"Persian-language text\"><span lang=\"fa\" dir=\"rtl\">ویکی‌پدیای فارسی</span></span>",
        "rtl": true
    },
    "he": {
        "english": "Hebrew Wikipedia",
        "native": "<span title=\"Hebrew-language text\"><span lang=\"he\" dir=\"rtl\">ויקיפדיה העברית</span></span>",
        "rtl": true
    },
    "ko": {
        "english": "Korean Wikipedia",
        "native": "<span title=\"Korean-language text\"><span lang=\"ko\">한국어 위키백과</span></span>"
    },
    "pt": {
        "english": "Portuguese Wikipedia",
        "native": "<span title=\"Portuguese-language text\"><span lang=\"pt\">Wikipédia em português</span></span>"
    },
    "ar": {
        "english": "Arabic Wikipedia",
        "native": "<span title=\"Arabic-language text\"><span lang=\"ar\" dir=\"rtl\">ويكيبيديا العربية</span></span>",
        "rtl": true
    },
    "nl": {
        "english": "Dutch Wikipedia",
        "native": "<span title=\"Dutch-language text\"><span lang=\"nl\">Nederlandstalige Wikipedia</span></span>"
    },
    "ru": {
        "english": "Russian Wikipedia",
        "native": "<span title=\"Russian-language text\"><span lang=\"ru\">Русская Википедия</span></span>"
    },
    "it": {
        "english": "Italian Wikipedia",
        "native": "<span title=\"Italian-language text\"><span lang=\"it\">Wikipedia in italiano</span></span>"
    },
    "id": {
        "english": "Indonesian Wikipedia",
        "native": "<span title=\"Indonesian-language text\"><span lang=\"id\">Wikipedia bahasa Indonesia</span></span>"
    },
    "uk": {
        "english": "Ukrainian Wikipedia",
        "native": "<span title=\"Ukrainian-language text\"><span lang=\"uk\">Українська Вікіпедія</span></span>"
    },
    "tr": {
        "english": "Turkish Wikipedia",
        "native": "<span title=\"Turkish-language text\"><span lang=\"tr\">Türkçe Vikipedi</span></span>"
    },
    "cs": {
        "english": "Czech Wikipedia",
        "native": "<span title=\"Czech-language text\"><span lang=\"cs\">Česká Wikipedie</span></span>"
    },
    "vi": {
        "english": "Vietnamese Wikipedia",
        "native": "<span title=\"Vietnamese-language text\"><span lang=\"vi\">Wikipedia tiếng Việt</span></span>"
    },
    "sr": {
        "english": "Serbian Wikipedia",
        "native": "<span title=\"Serbian-language text\"><span lang=\"sr\">Википедија на српском језику</span></span>"
    },
    "ro": {
        "english": "Romanian Wikipedia",
        "native": "<span title=\"Romanian-language text\"><span lang=\"ro\">Wikipedia în limba română</span></span>"
    },
    "no": {
        "english": "Norwegian Wikipedia  (Bokmål)",
        "native": "<span title=\"Norwegian-language text\"><span lang=\"no\">Norsk Wikipedia</span></span>"
    },
    "sv": {
        "english": "Swedish Wikipedia",
        "native": "<span title=\"Swedish-language text\"><span lang=\"sv\">Svenskspråkiga Wikipedia</span></span>"
    },
    "hi": {
        "english": "Hindi Wikipedia",
        "native": "<span title=\"Hindi-language text\"><span lang=\"hi\">हिन्दी विकिपीडिया</span></span>"
    },
    "da": {
        "english": "Danish Wikipedia",
        "native": "<span title=\"Danish-language text\"><span lang=\"da\">Dansk Wikipedia</span></span>"
    },
    "simple": {
        "english": "Simple English Wikipedia",
        "native": "<span>Simple English Wikipedia</span>"
    },
    "fi": {
        "english": "Finnish Wikipedia",
        "native": "<span title=\"Finnish-language text\"><span lang=\"fi\">Suomenkielinen Wikipedia</span></span>"
    },
    "th": {
        "english": "Thai Wikipedia",
        "native": "<span title=\"Thai-language text\"><span lang=\"th\">วิกิพีเดียภาษาไทย</span></span>"
    },
    "hu": {
        "english": "Hungarian Wikipedia",
        "native": "<span title=\"Hungarian-language text\"><span lang=\"hu\">Magyar Wikipédia</span></span>"
    },
    "zh-yue": {
        "english": "Cantonese Wikipedia",
        "native": "<a href=\"/wiki/Traditional_Chinese_characters\" title=\"Traditional Chinese characters\">Traditional Chinese</a>"
    },
    "bn": {
        "english": "Bengali Wikipedia",
        "native": "<span title=\"Bengali-language text\"><span lang=\"bn\">বাংলা উইকিপিডিয়া</span></span>"
    },
    "ca": {
        "english": "Catalan Wikipedia",
        "native": "<span title=\"Catalan-language text\"><span lang=\"ca\">Viquipèdia en català</span></span>"
    },
    "az": {
        "english": "Azerbaijani Wikipedia",
        "native": "<span title=\"Azerbaijani-language text\"><span lang=\"az\">Azərbaycanca Vikipediya</span></span>"
    },
    "el": {
        "english": "Greek Wikipedia",
        "native": "<span title=\"Greek-language text\"><span lang=\"el\">Ελληνική Βικιπαίδεια</span></span>"
    },
    "bg": {
        "english": "Bulgarian Wikipedia",
        "native": "<span title=\"Bulgarian-language text\"><span lang=\"bg\">Българоезична Уикипедия</span></span>"
    },
    "ms": {
        "english": "Malay Wikipedia",
        "native": "<span title=\"Malay (macrolanguage)-language text\"><span lang=\"ms\">Wikipedia Bahasa Melayu</span></span>"
    },
    "hy": {
        "english": "Armenian Wikipedia",
        "native": "<span title=\"Armenian-language text\"><span lang=\"hy\">Հայերեն Վիքիպեդիա</span></span>"
    },
    "sk": {
        "english": "Slovak Wikipedia",
        "native": "<span title=\"Slovak-language text\"><span lang=\"sk\">Slovenská Wikipedia</span></span>"
    },
    "sw": {
        "english": "Swahili Wikipedia",
        "native": "<span title=\"Swahili (macrolanguage)-language text\"><span lang=\"sw\">Wikipedia ya Kiswahili</span></span>"
    },
    "hr": {
        "english": "Croatian Wikipedia",
        "native": "<span title=\"Croatian-language text\"><span lang=\"hr\">Hrvatska Wikipedija</span></span>"
    },
    "et": {
        "english": "Estonian Wikipedia",
        "native": "<span title=\"Estonian-language text\"><span lang=\"et\">Eestikeelne Vikipeedia</span></span>"
    },
    "sh": {
        "english": "Serbo-Croatian Wikipedia",
        "native": "<span title=\"Serbo-Croatian-language text\"><span lang=\"sh\">Srpskohrvatska Wikipedija</span></span>"
    },
    "uz": {
        "english": "Uzbek Wikipedia",
        "native": "<span title=\"Uzbek-language text\"><span lang=\"uz\">Oʻzbekcha Vikipediya</span></span>"
    },
    "eo": {
        "english": "Esperanto Wikipedia",
        "native": "<span title=\"Esperanto-language text\"><span lang=\"eo\">Vikipedio en Esperanto</span></span>"
    },
    "sl": {
        "english": "Slovene Wikipedia",
        "native": "<span title=\"Slovene-language text\"><span lang=\"sl\">Slovenska Wikipedija</span></span>"
    },
    "lt": {
        "english": "Lithuanian Wikipedia",
        "native": "<span title=\"Lithuanian-language text\"><span lang=\"lt\">Lietuviškoji Vikipedija</span></span>"
    },
    "eu": {
        "english": "Basque Wikipedia",
        "native": "<span title=\"Basque-language text\"><span lang=\"eu\">Euskarazko Wikipedia</span></span>"
    },
    "lv": {
        "english": "Latvian Wikipedia",
        "native": "<span title=\"Latvian-language text\"><span lang=\"lv\">Vikipēdija latviešu valodā</span></span>"
    },
    "ur": {
        "english": "Urdu Wikipedia",
        "native": "<span title=\"Urdu-language text\"><span lang=\"ur\" dir=\"rtl\">اردو ویکیپیڈیا</span></span>",
        "rtl": true
    },
    "ka": {
        "english": "Georgian Wikipedia",
        "native": "<span title=\"Georgian-language text\"><span lang=\"ka\">ქართული ვიკიპედია</span></span>"
    },
    "gl": {
        "english": "Galician Wikipedia",
        "native": "<span title=\"Galician-language text\"><span lang=\"gl\">Galipedia</span></span>"
    },
    "be": {
        "english": "Belarusian Wikipedia",
        "native": "<span title=\"Belarusian-language text\"><span lang=\"be\">Беларуская Вікіпедыя</span></span>"
    },
    "ta": {
        "english": "Tamil Wikipedia",
        "native": "<span title=\"Tamil-language text\"><span lang=\"ta\">தமிழ் விக்கிபீடியா</span></span>"
    },
    "kk": {
        "english": "Kazakh Wikipedia",
        "native": "<span title=\"Kazakh-language text\"><span lang=\"kk\">Қазақша Уикипедия</span></span>"
    },
    "sq": {
        "english": "Albanian Wikipedia",
        "native": "<span title=\"Albanian-language text\"><span lang=\"sq\">Wikipedia shqip</span></span>"
    },
    "ml": {
        "english": "Malayalam Wikipedia",
        "native": "<span title=\"Malayalam-language text\"><span lang=\"ml\">മലയാളം വിക്കിപീഡിയ</span></span>"
    },
    "mk": {
        "english": "Macedonian Wikipedia",
        "native": "<span title=\"Macedonian-language text\"><span lang=\"mk\">Македонска Википедија</span></span>"
    },
    "af": {
        "english": "Afrikaans Wikipedia",
        "native": "<span title=\"Afrikaans-language text\"><span lang=\"af\">Afrikaanse Wikipedia</span></span>"
    },
    "arz": {
        "english": "Egyptian Arabic Wikipedia",
        "native": "<span title=\"Egyptian Arabic-language text\"><span lang=\"arz\" dir=\"rtl\">ويكيپيديا مصرى</span></span>",
        "rtl": true
    },
    "te": {
        "english": "Telugu Wikipedia",
        "native": "<span title=\"Telugu-language text\"><span lang=\"te\">తెలుగు వికీపీడియా</span></span>"
    },
    "ha": {
        "english": "Hausa Wikipedia",
        "native": "<span title=\"Hausa-language text\"><span lang=\"ha\">Wikipedia Hausa</span></span>"
    },
    "tl": {
        "english": "Tagalog Wikipedia",
        "native": "<span title=\"Tagalog-language text\"><span lang=\"tl\">Wikipediang Tagalog</span></span>"
    },
    "la": {
        "english": "Latin Wikipedia",
        "native": "<span title=\"Latin-language text\"><span lang=\"la\">Vicipaedia Latina</span></span>"
    },
    "bs": {
        "english": "Bosnian Wikipedia",
        "native": "<span title=\"Bosnian-language text\"><span lang=\"bs\">Wikipedia na bosanskom jeziku</span></span>"
    },
    "ceb": {
        "english": "Cebuano Wikipedia",
        "native": "<span title=\"Cebuano-language text\"><span lang=\"ceb\">Wikipedya sa Sinugboanon</span></span>"
    },
    "ig": {
        "english": "Igbo Wikipedia",
        "native": "<span title=\"Igbo-language text\"><span lang=\"ig\">Wikipedia Igbo</span></span>"
    },
    "is": {
        "english": "Icelandic Wikipedia",
        "native": "<span title=\"Icelandic-language text\"><span lang=\"is\">Íslenska Wikipedia</span></span>"
    },
    "mn": {
        "english": "Mongolian Wikipedia",
        "native": "<span title=\"Mongolian-language text\"><span lang=\"mn\">Монгол Википедиа</span></span>"
    },
    "mr": {
        "english": "Marathi Wikipedia",
        "native": "<span title=\"Marathi-language text\"><span lang=\"mr\">मराठी विकिपीडिया</span></span>"
    },
    "my": {
        "english": "Burmese Wikipedia",
        "native": "<span title=\"Burmese-language text\"><span lang=\"my\">မြန်မာဝီကီပီးဒီးယား</span></span>"
    },
    "ckb": {
        "english": "Sorani Kurdish Wikipedia",
        "native": "<span title=\"Sorani Kurdish-language text\"><span lang=\"ckb\" dir=\"rtl\">ویکیپیدیای کوردیی سۆرانی</span></span>",
        "rtl": true
    },
    "kn": {
        "english": "Kannada Wikipedia",
        "native": "<span title=\"Kannada-language text\"><span lang=\"kn\">ಕನ್ನಡ ವಿಕಿಪೀಡಿಯ</span></span>"
    },
    "bcl": {
        "english": "Central Bikol Wikipedia",
        "native": "<span title=\"Central Bikol-language text\"><span lang=\"bcl\">Wikipedyang Bikol Sentral</span></span>"
    },
    "cy": {
        "english": "Welsh Wikipedia",
        "native": "<span title=\"Welsh-language text\"><span lang=\"cy\">Wicipedia Cymraeg</span></span>"
    },
    "nn": {
        "english": "Norwegian Wikipedia  (Nynorsk)",
        "native": "<span title=\"Nynorsk-language text\"><span lang=\"nn\">Norsk (Nynorsk) Wikipedia</span></span>"
    },
    "ast": {
        "english": "Asturian Wikipedia",
        "native": "<span title=\"Asturian-language text\"><span lang=\"ast\">Wikipedia n'asturianu</span></span>"
    },
    "ne": {
        "english": "Nepali Wikipedia",
        "native": "<span title=\"Nepali (macrolanguage)-language text\"><span lang=\"ne\">नेपाली विकिपिडिया</span></span>"
    },
    "be-tarask": {
        "english": "Belarusian Wikipedia  (Classical)",
        "native": "<span title=\"Belarusian-language text\"><span lang=\"be\">Беларуская Вікіпэдыя</span></span>"
    },
    "as": {
        "english": "Assamese Wikipedia",
        "native": "<span title=\"Assamese-language text\"><span lang=\"as\">অসমীয়া ৱিকিপিডিয়া</span></span>"
    },
    "br": {
        "english": "Breton Wikipedia",
        "native": "<span title=\"Breton-language text\"><span lang=\"br\">Wikipedia e brezhoneg</span></span>"
    },
    "si": {
        "english": "Sinhala Wikipedia",
        "native": "<span title=\"Sinhala-language text\"><span lang=\"si\">සිංහල විකිපීඩියා</span></span>"
    },
    "oc": {
        "english": "Occitan Wikipedia",
        "native": "<span title=\"Occitan (post 1500)-language text\"><span lang=\"oc\">Wikipèdia en occitan</span></span>"
    },
    "jv": {
        "english": "Javanese Wikipedia",
        "native": "<span title=\"Javanese-language text\"><span lang=\"jv\">Wikipedia basa Jawa</span></span>"
    },
    "ku": {
        "english": "Kurdish Wikipedia",
        "native": "<span title=\"Kurdish-language text\"><span lang=\"ku\">Wîkîpediya kurdî</span></span>"
    },
    "sco": {
        "english": "Scots Wikipedia",
        "native": "<span title=\"Scots-language text\"><span lang=\"sco\">Scots Wikipædia</span></span>"
    },
    "lb": {
        "english": "Luxembourgish Wikipedia",
        "native": "<span title=\"Luxembourgish-language text\"><span lang=\"lb\">Wikipedia op Lëtzebuergesch</span></span>"
    },
    "azb": {
        "english": "South Azerbaijani Wikipedia",
        "native": "<span title=\"South Azerbaijani-language text\"><span lang=\"azb\" dir=\"rtl\">تورکجه ویکی‌پدیا</span></span>",
        "rtl": true
    },
    "tg": {
        "english": "Tajik Wikipedia",
        "native": "<span title=\"Tajik-language text\"><span lang=\"tg\">Википедияи Тоҷикӣ</span></span>"
    },
    "als": {
        "english": "Alemannic Wikipedia",
        "native": "<span title=\"Alemannic German-language text\"><span lang=\"gsw\">Alemannische Wikipedia</span></span>"
    },
    "zh-min-nan": {
        "english": "Southern Min Wikipedia",
        "native": "<a href=\"/wiki/Pe%CC%8Dh-%C5%8De-j%C4%AB\" title=\"Pe̍h-ōe-jī\">Pe̍h-ōe-jī</a>"
    },
    "pa": {
        "english": "Punjabi Wikipedia",
        "native": "<span title=\"Punjabi-language text\"><span lang=\"pa\">ਪੰਜਾਬੀ ਵਿਕੀਪੀਡੀਆ</span></span>"
    },
    "wuu": {
        "english": "Wu Wikipedia",
        "native": "<a href=\"/wiki/Traditional_Chinese_characters\" title=\"Traditional Chinese characters\">Traditional Chinese</a>"
    },
    "ga": {
        "english": "Irish Wikipedia",
        "native": "<span title=\"Irish-language text\"><span lang=\"ga\">Vicipéid na Gaeilge</span></span>"
    },
    "an": {
        "english": "Aragonese Wikipedia",
        "native": "<span title=\"Aragonese-language text\"><span lang=\"an\">Biquipedia en aragonés</span></span>"
    },
    "fy": {
        "english": "West Frisian Wikipedia",
        "native": "<span title=\"West Frisian-language text\"><span lang=\"fy\">Frysktalige Wikipedy</span></span>"
    },
    "km": {
        "english": "Khmer Wikipedia",
        "native": "<span title=\"Khmer-language text\"><span lang=\"km\">វិគីភីឌាភាសាខ្មែរ</span></span>"
    },
    "so": {
        "english": "Somali Wikipedia",
        "native": "<span title=\"Somali-language text\"><span lang=\"so\">Soomaali Wikipedia</span></span>"
    },
    "war": {
        "english": "Waray Wikipedia",
        "native": "<span title=\"Waray (Philippines)-language text\"><span lang=\"war\">Waray Wikipedia</span></span>"
    },
    "io": {
        "english": "Ido Wikipedia",
        "native": "<span title=\"Ido-language text\"><span lang=\"io\">Wikipedio en Ido</span></span>"
    },
    "ky": {
        "english": "Kyrgyz Wikipedia",
        "native": "<span title=\"Kyrgyz-language text\"><span lang=\"ky\">Кыргыз Википедиясы</span></span>"
    },
    "gu": {
        "english": "Gujarati Wikipedia",
        "native": "<span title=\"Gujarati-language text\"><span lang=\"gu\">ગુજરાતી વિકિપીડિયા</span></span>"
    },
    "zu": {
        "english": "Zulu Wikipedia",
        "native": "<span title=\"Zulu-language text\"><span lang=\"zu\">Wikipedia isiZulu</span></span>"
    },
    "bar": {
        "english": "Bavarian Wikipedia",
        "native": "<span title=\"Bavarian-language text\"><span lang=\"bar\">Boarische Wikipedia</span></span>"
    },
    "yo": {
        "english": "Yoruba Wikipedia",
        "native": "<span title=\"Yoruba-language text\"><span lang=\"yo\">Wikipéédíà Yorùbá</span></span>"
    },
    "zgh": {
        "english": "Moroccan Amazigh Wikipedia",
        "native": "<span title=\"Standard Moroccan Tamazight-language text\"><span lang=\"zgh\">ⵡⵉⴽⵉⴱⵉⴷⵢⴰ ⵜⴰⵎⴰⵣⵉⵖⵜ ⵜⴰⵏⴰⵡⴰⵢⵜ</span></span>"
    },
    "ba": {
        "english": "Bashkir Wikipedia",
        "native": "<span title=\"Bashkir-language text\"><span lang=\"ba\">Башҡорт Википедияһы</span></span>"
    },
    "sa": {
        "english": "Sanskrit Wikipedia",
        "native": "<span title=\"Sanskrit-language text\"><span lang=\"sa\">संस्कृतविकिपीडिया</span></span>"
    },
    "tt": {
        "english": "Tatar Wikipedia",
        "native": "<span title=\"Tatar-language text\"><span lang=\"tt\">Татар Википедиясе</span></span>"
    },
    "tn": {
        "english": "Tswana Wikipedia",
        "native": "<span title=\"Tswana-language text\"><span lang=\"tn\">Wikipedia Setswana</span></span>"
    },
    "ban": {
        "english": "Balinese Wikipedia",
        "native": "<span title=\"Balinese-language text\"><span lang=\"ban\">Wikipédia Basa Bali</span></span>"
    },
    "zh-classical": {
        "english": "Classical Chinese Wikipedia",
        "native": "<span title=\"Literary Chinese-language text\"><span lang=\"lzh-Hant\">文言維基大典</span></span>"
    },
    "su": {
        "english": "Sundanese Wikipedia",
        "native": "<span title=\"Sundanese-language text\"><span lang=\"su\">Wikipédia basa Sunda</span></span>"
    },
    "pnb": {
        "english": "Western Punjabi Wikipedia",
        "native": "<span title=\"Punjabi (Western)-language text\"><span lang=\"pnb\" dir=\"rtl\">پنجابی وکیپیڈیا</span></span>",
        "rtl": true
    },
    "hif": {
        "english": "Fiji Hindi Wikipedia",
        "native": "<span title=\"Fiji Hindi-language text\"><span lang=\"hif\">Fiji Baat Wikipedia</span></span>"
    },
    "ce": {
        "english": "Chechen Wikipedia",
        "native": "<span title=\"Chechen-language text\"><span lang=\"ce\">Нохчийн Википеди</span></span>"
    },
    "cv": {
        "english": "Chuvash Wikipedia",
        "native": "<span title=\"Chuvash-language text\"><span lang=\"cv\">Чăваш Википедийĕ</span></span>"
    },
    "am": {
        "english": "Amharic Wikipedia",
        "native": "<span title=\"Amharic-language text\"><span lang=\"am\">አማርኛ ዊኪፔዲያ</span></span>"
    },
    "ang": {
        "english": "Old English Wikipedia",
        "native": "<span title=\"Old English (ca. 450-1100)-language text\"><span lang=\"ang\">Engliscan Ƿikipǣdia</span></span>"
    },
    "rw": {
        "english": "Kinyarwanda Wikipedia",
        "native": "<span title=\"Kinyarwanda-language text\"><span lang=\"rw\">Wikipediya mu Ikinyarwanda</span></span>"
    },
    "ps": {
        "english": "Pashto Wikipedia",
        "native": "<span title=\"Pashto-language text\"><span lang=\"ps\" dir=\"rtl\">پښتو ويکيپېډيا</span></span>",
        "rtl": true
    },
    "dag": {
        "english": "Dagbani Wikipedia",
        "native": "<span title=\"Dagbani-language text\"><span lang=\"dag\">Wikipidia Dagbani</span></span>"
    },
    "mg": {
        "english": "Malagasy Wikipedia",
        "native": "<span title=\"Malagasy-language text\"><span lang=\"mg\">Wikipedia amin'ny teny malagasy</span></span>"
    },
    "mt": {
        "english": "Maltese Wikipedia",
        "native": "<span title=\"Maltese-language text\"><span lang=\"mt\">Wikipedija Malti</span></span>"
    },
    "qu": {
        "english": "Quechua Wikipedia",
        "native": "<span title=\"Quechua-language text\"><span lang=\"qu\">Qhichwa Wikipidiya</span></span>"
    },
    "ht": {
        "english": "Haitian Creole Wikipedia",
        "native": "<span title=\"Haitian Creole-language text\"><span lang=\"ht\">Wikipedya kreyòl ayisyen</span></span>"
    },
    "ia": {
        "english": "Interlingua Wikipedia",
        "native": "<span title=\"Interlingua (International Auxiliary Language Association)-language text\"><span lang=\"ia\">Wikipedia in interlingua</span></span>"
    },
    "kaa": {
        "english": "Karakalpak Wikipedia",
        "native": "<span title=\"Karakalpak-language text\"><span lang=\"kaa\">Qaraqalpaq Wikipediası</span></span>"
    },
    "or": {
        "english": "Odia Wikipedia",
        "native": "<span title=\"Odia-language text\"><span lang=\"or\">ଓଡ଼ିଆ ଉଇକିପିଡ଼ିଆ</span></span>"
    },
    "tw": {
        "english": "Twi Wikipedia",
        "native": "<span title=\"Twi-language text\"><span lang=\"tw\">Wikipidia Twi</span></span>"
    },
    "fo": {
        "english": "Faroese Wikipedia",
        "native": "<span title=\"Faroese-language text\"><span lang=\"fo\">Føroysk Wikipedia</span></span>"
    },
    "gpe": {
        "english": "Ghanaian Pidgin Wikipedia",
        "native": "<span title=\"Ghanaian Pidgin English-language text\"><span lang=\"gpe\">Ghanaian Pidgin Wikipedia</span></span>"
    },
    "rue": {
        "english": "Rusyn Wikipedia",
        "native": "<span title=\"Rusyn-language text\"><span lang=\"rue\">Русиньска Вікіпедія</span></span>"
    },
    "vec": {
        "english": "Venetian Wikipedia",
        "native": "<span title=\"Venetian-language text\"><span lang=\"vec\">Wikipedia en łéngoa vèneta</span></span>"
    },
    "ary": {
        "english": "Moroccan Arabic Wikipedia",
        "native": "<span title=\"Moroccan Arabic-language text\"><span lang=\"ary\" dir=\"rtl\">ويكيبيديا المغربية</span></span>",
        "rtl": true
    },
    "bo": {
        "english": "Tibetan Wikipedia",
        "native": "<span title=\"Standard Tibetan-language text\"><span lang=\"bo\">བོད་ཡིག་གི་ཝེ་ཁེ་རིག་མཛོད</span></span>"
    },
    "min": {
        "english": "Minangkabau Wikipedia",
        "native": "<span title=\"Minangkabau-language text\"><span lang=\"min\">Wikipedia Minangkabau</span></span>"
    },
    "szl": {
        "english": "Silesian Wikipedia",
        "native": "<span title=\"Silesian-language text\"><span lang=\"szl\">Ślůnsko Wikipedyjo</span></span>"
    },
    "lmo": {
        "english": "Lombard Wikipedia",
        "native": "<span title=\"Lombard-language text\"><span lang=\"lmo\">Wikipedia in lombard</span></span>"
    },
    "nds": {
        "english": "Low German Wikipedia",
        "native": "<span title=\"Low German-language text\"><span lang=\"nds\">Plattdüütsche Wikipedia</span></span>"
    },
    "sd": {
        "english": "Sindhi Wikipedia",
        "native": "<span title=\"Sindhi-language text\"><span lang=\"sd\" dir=\"rtl\">سنڌي وڪيپيڊيا</span></span>",
        "rtl": true
    },
    "st": {
        "english": "Sotho Wikipedia",
        "native": "<span title=\"Sotho-language text\"><span lang=\"st\">Wikipedia Sesotho</span></span>"
    },
    "sat": {
        "english": "Santali Wikipedia",
        "native": "<span title=\"Santali-language text\"><span lang=\"sat\">ᱥᱟᱱᱛᱟᱲᱤ ᱣᱤᱠᱤᱯᱤᱰᱤᱭᱟ</span></span>"
    },
    "scn": {
        "english": "Sicilian Wikipedia",
        "native": "<span title=\"Sicilian-language text\"><span lang=\"scn\">Wikipedia ’n sicilianu</span></span>"
    },
    "yi": {
        "english": "Yiddish Wikipedia",
        "native": "<span title=\"Yiddish-language text\"><span lang=\"yi\" dir=\"rtl\">יידישע וויקיפעדיע</span></span>",
        "rtl": true
    },
    "mos": {
        "english": "Mooré Wikipedia",
        "native": "<span title=\"Mossi-language text\"><span lang=\"mos\">Wikipidiya Mossi</span></span>"
    },
    "crh": {
        "english": "Crimean Tatar Wikipedia",
        "native": "<span title=\"Crimean Tatar-language text\"><span lang=\"crh\">Qırımtatarca Vikipediya</span></span>"
    },
    "lld": {
        "english": "Ladin Wikipedia",
        "native": "<span title=\"Ladin-language text\"><span lang=\"lld\">Wikipedia per ladin</span></span>"
    },
    "lo": {
        "english": "Lao Wikipedia",
        "native": "<span title=\"Lao-language text\"><span lang=\"lo\">ວິກິພີເດຍ ພາສາລາວ</span></span>"
    },
    "mad": {
        "english": "Madurese Wikipedia",
        "native": "<span title=\"Madurese-language text\"><span lang=\"mad\">Wikipèḍia bhâsa Madhurâ</span></span>"
    },
    "li": {
        "english": "Limburgish Wikipedia",
        "native": "<span title=\"Limburgish-language text\"><span lang=\"li\">Limburgse Wikipedia</span></span>"
    },
    "mzn": {
        "english": "Mazanderani Wikipedia",
        "native": "<span title=\"Mazanderani-language text\"><span lang=\"mzn\" dir=\"rtl\">مازرونی ویکی‌پدیا</span></span>",
        "rtl": true
    },
    "pdc": {
        "english": "Pennsylvania Dutch Wikipedia",
        "native": "<span title=\"Pennsylvania German-language text\"><span lang=\"pdc\">Pennsilfaanisch-Deitsche Wikipedelche</span></span>"
    },
    "gan": {
        "english": "Gan Wikipedia",
        "native": "<a href=\"/wiki/Traditional_Chinese_characters\" title=\"Traditional Chinese characters\">Traditional Chinese</a>"
    },
    "hyw": {
        "english": "Western Armenian Wikipedia",
        "native": "<span title=\"Western Armenian-language text\"><span lang=\"hyw\">Արեւմտահայերէն Ուիքիփետիա</span></span>"
    },
    "sah": {
        "english": "Yakut Wikipedia",
        "native": "<span title=\"Yakut-language text\"><span lang=\"sah\">Сахалыы Бикипиэдьийэ</span></span>"
    },
    "gn": {
        "english": "Guarani Wikipedia",
        "native": "<span title=\"Guarani-language text\"><span lang=\"gn\">Vikipetã avañe'ẽme</span></span>"
    },
    "dga": {
        "english": "Dagaare Wikipedia",
        "native": "<span title=\"Southern Dagaare-language text\"><span lang=\"dga\">Dagaare Wikipiideɛ</span></span>"
    },
    "nap": {
        "english": "Neapolitan Wikipedia",
        "native": "<span title=\"Neapolitan-language text\"><span lang=\"nap\">Wikipedia napulitana</span></span>"
    },
    "hsb": {
        "english": "Upper Sorbian Wikipedia",
        "native": "<span title=\"Upper Sorbian-language text\"><span lang=\"hsb\">Hornjoserbska wikipedija</span></span>"
    },
    "pms": {
        "english": "Piedmontese Wikipedia",
        "native": "<span title=\"Piedmontese-language text\"><span lang=\"pms\">Wikipedia an piemontèisa</span></span>"
    },
    "ab": {
        "english": "Abkhaz Wikipedia",
        "native": "<span title=\"Abkhaz-language text\"><span lang=\"ab\">Аԥсуа авикипедиа</span></span>"
    },
    "gd": {
        "english": "Scottish Gaelic Wikipedia",
        "native": "<span title=\"Scottish Gaelic-language text\"><span lang=\"gd\">Uicipeid na Gàidhlig</span></span>"
    },
    "ff": {
        "english": "Fula Wikipedia",
        "native": "<span title=\"Fula-language text\"><span lang=\"ff\">Wikipedia Fulfude</span></span>"
    },
    "vo": {
        "english": "Volapük Wikipedia",
        "native": "<span title=\"Volapük-language text\"><span lang=\"vo\">Vükiped Volapükik</span></span>"
    },
    "sc": {
        "english": "Sardinian Wikipedia",
        "native": "<span title=\"Sardinian-language text\"><span lang=\"sc\">Wikipedia in sardu</span></span>"
    },
    "co": {
        "english": "Corsican Wikipedia",
        "native": "<span title=\"Corsican-language text\"><span lang=\"co\">Corsipedia</span></span>"
    },
    "frp": {
        "english": "Franco-Provençal Wikipedia",
        "native": "<span title=\"Arpitan-language text\"><span lang=\"frp\">Vouiquipèdia en arpetan</span></span>"
    },
    "hak": {
        "english": "Hakka Wikipedia",
        "native": "<a href=\"/wiki/Pha%CC%8Dk-fa-s%E1%B9%B3\" title=\"Pha̍k-fa-sṳ\">Pha̍k-fa-sṳ</a>"
    },
    "ie": {
        "english": "Interlingue Wikipedia",
        "native": "<span title=\"Interlingue-language text\"><span lang=\"ie\">Wikipedia in Interlingue</span></span>"
    },
    "pap": {
        "english": "Papiamento Wikipedia",
        "native": "<span title=\"Papiamento-language text\"><span lang=\"pap\">Wikipedia na papiamentu</span></span>"
    },
    "tum": {
        "english": "Tumbuka Wikipedia",
        "native": "<span title=\"Tumbuka-language text\"><span lang=\"tum\">Wikipedia Chitumbuka</span></span>"
    },
    "pam": {
        "english": "Kapampangan Wikipedia",
        "native": "<span title=\"Kapampangan-language text\"><span lang=\"pam\">Wikipediang Kapampángan</span></span>"
    },
    "lfn": {
        "english": "Lingua Franca Nova Wikipedia",
        "native": "<span title=\"Lingua Franca Nova-language text\"><span lang=\"lfn\">Vicipedia en lingua franca nova</span></span>"
    },
    "tly": {
        "english": "Talysh Wikipedia",
        "native": "<span title=\"Talysh-language text\"><span lang=\"tly\">Tolyšə Vikipedijə</span></span>"
    },
    "tk": {
        "english": "Turkmen Wikipedia",
        "native": "<span title=\"Turkmen-language text\"><span lang=\"tk\">Türkmençe Wikipediýa</span></span>"
    },
    "diq": {
        "english": "Zazaki Wikipedia",
        "native": "<span title=\"Zazaki-language text\"><span lang=\"diq\">Wikipediyay Zazaki</span></span>"
    },
    "mai": {
        "english": "Maithili Wikipedia",
        "native": "<span title=\"Maithili-language text\"><span lang=\"mai\">मैथिली विकिपिडिया</span></span>"
    },
    "bjn": {
        "english": "Banjarese Wikipedia",
        "native": "<span title=\"Banjar-language text\"><span lang=\"bjn\">Wikipidia basa Banjar</span></span>"
    },
    "kab": {
        "english": "Kabyle Wikipedia",
        "native": "<span title=\"Kabyle-language text\"><span lang=\"kab\">Wikipedia taqbaylit</span></span>"
    },
    "lg": {
        "english": "Luganda Wikipedia",
        "native": "<span title=\"Luganda-language text\"><span lang=\"lg\">Wikipediya Luganda</span></span>"
    },
    "frr": {
        "english": "North Frisian Wikipedia",
        "native": "<span title=\"North Frisian-language text\"><span lang=\"frr\">Nordfriisk Wikipedia</span></span>"
    },
    "wa": {
        "english": "Walloon Wikipedia",
        "native": "<span title=\"Walloon-language text\"><span lang=\"wa\">Wikipedia e walon</span></span>"
    },
    "vls": {
        "english": "West Flemish Wikipedia",
        "native": "<span title=\"West Flemish-language text\"><span lang=\"vls\">West-Vlamse Wikipedia</span></span>"
    },
    "xh": {
        "english": "Xhosa Wikipedia",
        "native": "<span title=\"Xhosa-language text\"><span lang=\"xh\">Wikipedia isiXhosa</span></span>"
    },
    "bh": {
        "english": "Bhojpuri Wikipedia",
        "native": "<span title=\"Bihari languages collective text\"><span lang=\"bh\">बिहारी विकिपीडिया</span></span>"
    },
    "ace": {
        "english": "Acehnese Wikipedia",
        "native": "<span title=\"Acehnese-language text\"><span lang=\"ace\">Wikipèdia bahsa Acèh</span></span>"
    },
    "lij": {
        "english": "Ligurian Wikipedia",
        "native": "<span title=\"Ligurian-language text\"><span lang=\"lij\">Wikipedia Ligure</span></span>"
    },
    "iu": {
        "english": "Inuktitut Wikipedia",
        "native": "<span title=\"Inuktitut-language text\"><span lang=\"iu\">ᐃᓄᒃᑎᑐᑦ ᐊᕆᐅᙵᐃᐹ</span></span>"
    },
    "mni": {
        "english": "Meitei Wikipedia",
        "native": "<span title=\"Meitei-language text\"><span lang=\"mni\">ꯃꯤꯇꯩꯂꯣꯟ ꯋꯤꯀꯤꯄꯦꯗꯤꯌꯥ</span></span>"
    },
    "xmf": {
        "english": "Mingrelian Wikipedia",
        "native": "<span title=\"Mingrelian-language text\"><span lang=\"xmf\">მარგალური ვიკიპედია</span></span>"
    },
    "pcm": {
        "english": "Nigerian Pidgin Wikipedia",
        "native": "<span title=\"Nigerian Pidgin-language text\"><span lang=\"pcm\">Naijá Wikipedia</span></span>"
    },
    "ug": {
        "english": "Uyghur Wikipedia",
        "native": "<a href=\"/wiki/Uyghur_Arabic_alphabet\" title=\"Uyghur Arabic alphabet\">UEY</a>"
    },
    "haw": {
        "english": "Hawaiian Wikipedia",
        "native": "<span title=\"Hawaiian-language text\"><span lang=\"haw\">Hawai‘i Wikipikia</span></span>"
    },
    "gv": {
        "english": "Manx Wikipedia",
        "native": "<span title=\"Manx-language text\"><span lang=\"gv\">Wikipedia yn Gaelg</span></span>"
    },
    "cu": {
        "english": "Old Church Slavonic Wikipedia",
        "native": "<span title=\"Church Slavonic-language text\"><span lang=\"cu\">Словѣньска Википєдїꙗ</span></span>"
    },
    "shn": {
        "english": "Shan Wikipedia",
        "native": "<span title=\"Shan-language text\"><span lang=\"shn\">ဝီႇၶီႇၽီးတီးယႃးတႆး</span></span>"
    },
    "shi": {
        "english": "Shilha Wikipedia",
        "native": "<span title=\"Tachelhit-language text\"><span lang=\"shi\">Wikipidya taclḥiyt</span></span>"
    },
    "smn": {
        "english": "Inari Sámi Wikipedia",
        "native": "<span title=\"Inari Sami-language text\"><span lang=\"smn\">Anarâškielâlâš Wikipedia</span></span>"
    },
    "rn": {
        "english": "Kirundi Wikipedia",
        "native": "<span title=\"Kirundi-language text\"><span lang=\"rn\">Wikipediya mu Ikirundi</span></span>"
    },
    "nso": {
        "english": "Northern Sotho Wikipedia",
        "native": "<span title=\"Northern Sotho-language text\"><span lang=\"nso\">Wikipedia Sesotho sa Leboa</span></span>"
    },
    "pcd": {
        "english": "Picard Wikipedia",
        "native": "<span title=\"Picard-language text\"><span lang=\"pcd\">Wikipédia in lingue picarde</span></span>"
    },
    "kcg": {
        "english": "Tyap Wikipedia",
        "native": "<span title=\"Tyap-language text\"><span lang=\"kcg\">Wukipedia nTyap</span></span>"
    },
    "vep": {
        "english": "Veps Wikipedia",
        "native": "<span title=\"Veps-language text\"><span lang=\"vep\">Vepsän Vikipedii</span></span>"
    },
    "ks": {
        "english": "Kashmiri Wikipedia",
        "native": "<span title=\"Kashmiri-language text\"><span lang=\"ks\" dir=\"rtl\">کٲشُر وِکیٖپیٖڈیا</span></span>",
        "rtl": true
    },
    "os": {
        "english": "Ossetian Wikipedia",
        "native": "<span title=\"Ossetian-language text\"><span lang=\"os\">Ирон Википеди</span></span>"
    },
    "av": {
        "english": "Avar Wikipedia",
        "native": "<span title=\"Avar-language text\"><span lang=\"av\">Авар Википедия</span></span>"
    },
    "awa": {
        "english": "Awadhi Wikipedia",
        "native": "<span title=\"Awadhi-language text\"><span lang=\"awa\">अवधी विकिपीडिया</span></span>"
    },
    "bxr": {
        "english": "Buryat Wikipedia",
        "native": "<span title=\"Russian Buryat-language text\"><span lang=\"bxr\">Буряад Википеэди</span></span>"
    },
    "kw": {
        "english": "Cornish Wikipedia",
        "native": "<span title=\"Cornish-language text\"><span lang=\"kw\">Wikipedya Kernowek</span></span>"
    },
    "cdo": {
        "english": "Eastern Min Wikipedia",
        "native": "<a href=\"/wiki/B%C3%A0ng-u%C3%A2-c%C3%AA\" title=\"Bàng-uâ-cê\">Bàng-uâ-cê</a>"
    },
    "fon": {
        "english": "Fon Wikipedia",
        "native": "<span title=\"Fon-language text\"><span lang=\"fon\">Wikipedya ɖò Fɔngbemɛ</span></span>"
    },
    "lad": {
        "english": "Judaeo-Spanish Wikipedia",
        "native": "<span title=\"Ladino-language text\"><span lang=\"lad\">Vikipedya en lingua Judeo-Espanyola</span></span>"
    },
    "dv": {
        "english": "Maldivian Wikipedia",
        "native": "<span title=\"Dhivehi-language text\"><span lang=\"dv\" dir=\"rtl\">ދިވެހި ވިކިޕީޑިޔާ</span></span>",
        "rtl": true
    },
    "mdf": {
        "english": "Moksha Wikipedia",
        "native": "<span title=\"Moksha-language text\"><span lang=\"mdf\">Мокшень Википедиесь</span></span>"
    },
    "new": {
        "english": "Newar Wikipedia",
        "native": "<span title=\"Newar-language text\"><span lang=\"new\">विकिपिडियाय् लसकुस</span></span>"
    },
    "bpy": {
        "english": "Bishnupriya Manipuri Wikipedia",
        "native": "<span title=\"Bishnupriya Manipuri-language text\"><span lang=\"bpy\">বিষ্ণুপ্রিয়া মণিপুরী উইকিপিডিয়া</span></span>"
    },
    "dtp": {
        "english": "Dusun Wikipedia",
        "native": "<span title=\"Kadazan Dusun-language text\"><span lang=\"dtp\">Wikipedia Kadazandusun</span></span>"
    },
    "eml": {
        "english": "Emilian–Romagnol Wikipedia",
        "native": "<span title=\"Emilian-language text\"><span lang=\"egl\">Emiliàn e rumagnòl Vichipedèia</span></span>"
    },
    "guw": {
        "english": "Gun Wikipedia",
        "native": "<span title=\"Gun-language text\"><span lang=\"guw\">Gungbe Wikipedia</span></span>"
    },
    "gur": {
        "english": "Gurene Wikipedia",
        "native": "<span title=\"Farefare-language text\"><span lang=\"gur\">Gurenɛ Wikipedia</span></span>"
    },
    "ilo": {
        "english": "Ilocano Wikipedia",
        "native": "<span title=\"Ilocano-language text\"><span lang=\"ilo\">Wikipedia nga Ilokano</span></span>"
    },
    "csb": {
        "english": "Kashubian Wikipedia",
        "native": "<span title=\"Kashubian-language text\"><span lang=\"csb\">Kaszëbskô Wikipedijô</span></span>"
    },
    "mi": {
        "english": "Māori Wikipedia",
        "native": "<span title=\"Māori-language text\"><span lang=\"mi\">Wikipedia Māori</span></span>"
    },
    "nds-nl": {
        "english": "Dutch Low Saxon Wikipedia",
        "native": "<span title=\"Dutch Low Saxon-language text\"><span lang=\"nds-NL\">Nedersaksische Wikipedie</span></span>"
    },
    "ext": {
        "english": "Extremaduran Wikipedia",
        "native": "<span title=\"Extremaduran-language text\"><span lang=\"ext\">Güiquipeya en estremeñu</span></span>"
    },
    "bat-smg": {
        "english": "Samogitian Wikipedia",
        "native": "<span title=\"Samogitian-language text\"><span lang=\"sgs\">Žemaitėška Vikipedėjė</span></span>"
    },
    "gag": {
        "english": "Gagauz Wikipedia",
        "native": "<span title=\"Gagauz-language text\"><span lang=\"gag\">Gagauzca Vikipediya</span></span>"
    },
    "dsb": {
        "english": "Lower Sorbian Wikipedia",
        "native": "<span title=\"Lower Sorbian-language text\"><span lang=\"dsb\">Dolnoserbska wikipedija</span></span>"
    },
    "blk": {
        "english": "Pa'O Wikipedia",
        "native": "<span title=\"Pa'o Karen-language text\"><span lang=\"blk\">ပအိုဝ်ႏဝီခီပီးဒီးယား</span></span>"
    },
    "rm": {
        "english": "Romansh Wikipedia",
        "native": "<span title=\"Romansh-language text\"><span lang=\"rm\">Vichipedia rumantscha</span></span>"
    },
    "tcy": {
        "english": "Tulu Wikipedia",
        "native": "<span title=\"Tulu-language text\"><span lang=\"tcy\">ತುಳು ವಿಕಿಪೀಡಿಯ</span></span>"
    },
    "cr": {
        "english": "Cree Wikipedia",
        "native": "<span title=\"Cree-language text\"><span lang=\"cr\">ᐎᑭᐱᑎᔭ ᓀᐦᐃᔭᐍᐏᐣ</span></span>"
    },
    "jam": {
        "english": "Jamaican Patois Wikipedia",
        "native": "<span title=\"Jamaican Patois-language text\"><span lang=\"jam\">Jumiekan Patwa Wikipidia</span></span>"
    },
    "roa-tara": {
        "english": "Tarantino Wikipedia",
        "native": "<span title=\"Neapolitan-language text\"><span lang=\"nap\">Uicchipèdie tarandíne</span></span>"
    },
    "ay": {
        "english": "Aymara Wikipedia",
        "native": "<span title=\"Aymara-language text\"><span lang=\"ay\">Aymar Wikipidiya</span></span>"
    },
    "dz": {
        "english": "Dzongkha Wikipedia",
        "native": "<span title=\"Dzongkha-language text\"><span lang=\"dz\">རྫོང་ཁ་ཝེ་ཁེ་རིག་མཛོད</span></span>"
    },
    "fur": {
        "english": "Friulian Wikipedia",
        "native": "<span title=\"Friulian-language text\"><span lang=\"fur\">Vichipedie par furlan</span></span>"
    },
    "kv": {
        "english": "Komi Wikipedia",
        "native": "<span title=\"Komi-language text\"><span lang=\"kv\">Коми Википедия</span></span>"
    },
    "mwl": {
        "english": "Mirandese Wikipedia",
        "native": "<span title=\"Mirandese-language text\"><span lang=\"mwl\">Biquipédia an lhéngua mirandesa</span></span>"
    },
    "om": {
        "english": "Oromo Wikipedia",
        "native": "<span title=\"Oromo-language text\"><span lang=\"om\">Oromoo Wikipedia</span></span>"
    },
    "skr": {
        "english": "Saraiki Wikipedia",
        "native": "<span title=\"Saraiki-language text\"><span lang=\"skr\" dir=\"rtl\">سرائیکی ویٖکیٖپیڈیا</span></span>",
        "rtl": true
    },
    "nr": {
        "english": "Southern Ndebele Wikipedia",
        "native": "<span title=\"Southern Ndebele-language text\"><span lang=\"nr\">Wikiphidiya yelimi lesiNdebele</span></span>"
    },
    "cbk-zam": {
        "english": "Chavacano Wikipedia",
        "native": "<span title=\"Chavacano-language text\"><span lang=\"cbk\">Chavacano Wikipedia</span></span>"
    },
    "gor": {
        "english": "Gorontalo Wikipedia",
        "native": "<span title=\"Gorontalo-language text\"><span lang=\"gor\">Wikipedia bahasa Hulontalo</span></span>"
    },
    "kus": {
        "english": "Kusaal Wikipedia",
        "native": "<span title=\"Kusaal-language text\"><span lang=\"kus\">Wikipiidia Kʋsaal</span></span>"
    },
    "lez": {
        "english": "Lezgian Wikipedia",
        "native": "<span title=\"Lezgian-language text\"><span lang=\"lez\">Лезги Википедия</span></span>"
    },
    "btm": {
        "english": "Mandailing Batak Wikipedia",
        "native": "<span title=\"Batak Mandailing-language text\"><span lang=\"btm\">Wikipedia Saro Mandailing</span></span>"
    },
    "fiu-vro": {
        "english": "Võro Wikipedia",
        "native": "<span title=\"Võro-language text\"><span lang=\"vro\">Võrokeeline Vikipeediä</span></span>"
    },
    "arc": {
        "english": "Classical Syriac Wikipedia",
        "native": "<span title=\"Imperial Aramaic (700-300 BCE)-language text\"><span lang=\"arc\" dir=\"rtl\">ܘܝܩܝܦܕܝܐ ܠܫܢܐ ܣܘܪܝܝܐ</span></span>",
        "rtl": true
    },
    "ady": {
        "english": "Adyghe Wikipedia",
        "native": "<span title=\"Adyghe-language text\"><span lang=\"ady\">Адыгэ Википедие</span></span>"
    },
    "ami": {
        "english": "Amis Wikipedia",
        "native": "<span title=\"Amis-language text\"><span lang=\"ami\">Wikipitiya 'Amis</span></span>"
    },
    "bew": {
        "english": "Betawi Wikipedia",
        "native": "<span title=\"Betawi-language text\"><span lang=\"bew\">Wikipédi basa Betawi</span></span>"
    },
    "chr": {
        "english": "Cherokee Wikipedia",
        "native": "<span title=\"Cherokee-language text\"><span lang=\"chr\">ᏫᎩᏇᏗᏯ ᏣᎳᎩ</span></span>"
    },
    "dty": {
        "english": "Doteli Wikipedia",
        "native": "<span title=\"Dotyali-language text\"><span lang=\"dty\">डोटेली विकिपिडिया</span></span>"
    },
    "myv": {
        "english": "Erzya Wikipedia",
        "native": "<span title=\"Erzya-language text\"><span lang=\"myv\">Эрзянь Википедия</span></span>"
    },
    "glk": {
        "english": "Gilaki Wikipedia",
        "native": "<span title=\"Gilaki-language text\"><span lang=\"glk\" dir=\"rtl\">گیلکی ویکیپدیاٰ</span></span>",
        "rtl": true
    },
    "jbo": {
        "english": "Lojban Wikipedia",
        "native": "<span title=\"Lojban-language text\"><span lang=\"jbo\">ni'o la .uikipedi'as. pe lo jbobau</span></span>"
    },
    "nah": {
        "english": "Nahuatl Wikipedia",
        "native": "<span title=\"Nahuatl languages collective text\"><span lang=\"nah\">Huiquipedia nāhuatlahtōlcopa</span></span>"
    },
    "nov": {
        "english": "Novial Wikipedia",
        "native": "<span title=\"Novial-language text\"><span lang=\"nov\">Wikipedie in novial</span></span>"
    },
    "szy": {
        "english": "Sakizaya Wikipedia",
        "native": "<span title=\"Sakizaya-language text\"><span lang=\"szy\">Wikipitiya nu Sakizaya</span></span>"
    },
    "sn": {
        "english": "Shona Wikipedia",
        "native": "<span title=\"Serbo-Croatian-language text\"><span lang=\"sh\">Wikipedhiya chiShona</span></span>"
    },
    "ss": {
        "english": "Swazi Wikipedia",
        "native": "<span title=\"Swazi-language text\"><span lang=\"ss\">Wikipedia siSwati</span></span>"
    },
    "bi": {
        "english": "Bislama Wikipedia",
        "native": "<span title=\"Bislama-language text\"><span lang=\"bi\">Wikipedia long Bislama</span></span>"
    },
    "ny": {
        "english": "Chewa Wikipedia",
        "native": "<span title=\"Chichewa-language text\"><span lang=\"ny\">Wikipedia Chichewa</span></span>"
    },
    "ee": {
        "english": "Ewe Wikipedia",
        "native": "<span title=\"Ewe-language text\"><span lang=\"ee\">Wikipiɖia Eʋegbe</span></span>"
    },
    "iba": {
        "english": "Iban Wikipedia",
        "native": "<span title=\"Iban-language text\"><span lang=\"iba\">Iban Wikipedia</span></span>"
    },
    "inh": {
        "english": "Ingush Wikipedia",
        "native": "<span title=\"Ingush-language text\"><span lang=\"inh\">Гӏалгӏай Википеди</span></span>"
    },
    "avk": {
        "english": "Kotava Wikipedia",
        "native": "<span title=\"Kotava-language text\"><span lang=\"avk\">Wikipedia men Kotava</span></span>"
    },
    "mhr": {
        "english": "Meadow Mari Wikipedia",
        "native": "<span title=\"Meadow Mari-language text\"><span lang=\"mhr\">Олык Марий Википедий</span></span>"
    },
    "mnw": {
        "english": "Mon Wikipedia",
        "native": "<span title=\"Mon-language text\"><span lang=\"mnw\">ဝဳကဳပဳဒဳယာမန်</span></span>"
    },
    "nrm": {
        "english": "Norman Wikipedia",
        "native": "<a href=\"/wiki/Augeron\" title=\"Augeron\">Augeron</a>"
    },
    "nup": {
        "english": "Nupe Wikipedia",
        "native": "<span title=\"Nupe-Nupe-Tako-language text\"><span lang=\"nup\">Wikipedia Nya Nupe</span></span>"
    },
    "tpi": {
        "english": "Tok Pisin Wikipedia",
        "native": "<span title=\"Tok Pisin-language text\"><span lang=\"tpi\">Wikipedia long Tok Pisin</span></span>"
    },
    "ts": {
        "english": "Tsonga Wikipedia",
        "native": "<span title=\"Tsonga-language text\"><span lang=\"ts\">Wikipediya Xitsonga</span></span>"
    },
    "ve": {
        "english": "Venda Wikipedia",
        "native": "<span title=\"Venda-language text\"><span lang=\"ve\">Wikipedia nga tshiVenḓa</span></span>"
    },
    "gom": {
        "english": "Konkani Wikipedia",
        "native": "<span title=\"Goan Konkani-language text\"><span lang=\"gom\">कोंकणी विकिपीडिया</span></span>"
    },
    "se": {
        "english": "Northern Sámi Wikipedia",
        "native": "<span title=\"Northern Sami-language text\"><span lang=\"se\">Davvisámegiel Wikipedia</span></span>"
    },
    "anp": {
        "english": "Angika Wikipedia",
        "native": "<span title=\"Angika-language text\"><span lang=\"anp\">विकिपीडिया</span></span>"
    },
    "got": {
        "english": "Gothic Wikipedia",
        "native": "<span title=\"Gothic-language text\"><span lang=\"got\">𐌲𐌿𐍄𐌹𐍃𐌺 𐍅𐌹𐌺𐌹𐍀𐌰𐌹𐌳𐌾𐌰</span></span>"
    },
    "nv": {
        "english": "Navajo Wikipedia",
        "native": "<span title=\"Navajo-language text\"><span lang=\"nv\">Wikiibíídiiya Dinék'ehjí</span></span>"
    },
    "zea": {
        "english": "Zeelandic Wikipedia",
        "native": "<span title=\"Zeeuws-language text\"><span lang=\"zea\">Zeêuwstaelihe Wikipedia</span></span>"
    },
    "bug": {
        "english": "Buginese Wikipedia",
        "native": "<span title=\"Buginese-language text\"><span lang=\"bug\">ᨓᨗᨀᨗᨄᨙᨉᨗᨕ ᨅᨔ ᨕᨘᨁᨗ</span></span>"
    },
    "knc": {
        "english": "Central Kanuri Wikipedia"
    },
    "ki": {
        "english": "Kikuyu Wikipedia",
        "native": "<span title=\"Gikuyu-language text\"><span lang=\"ki\">Wikipedia Gĩgĩkũyũ</span></span>"
    },
    "lbe": {
        "english": "Lak Wikipedia",
        "native": "<span title=\"Lak-language text\"><span lang=\"lbe\">Лакку мазрал Википедия</span></span>"
    },
    "olo": {
        "english": "Livvi-Karelian Wikipedia",
        "native": "<span title=\"Livvi-language text\"><span lang=\"olo\">Livvinkarjalan Wikipedii</span></span>"
    },
    "nqo": {
        "english": "N'Ko Wikipedia",
        "native": "<span title=\"N'Ko-language text\"><span lang=\"nqo\" dir=\"rtl\">ߥߞߌߔߘߋߞߎ ߒߞߏ</span></span>",
        "rtl": true
    },
    "rmy": {
        "english": "Romani Wikipedia",
        "native": "<span title=\"Vlax Romani-language text\"><span lang=\"rmy\">Romani Vikipidiya</span></span>"
    },
    "stq": {
        "english": "Saterland Frisian Wikipedia",
        "native": "<span title=\"Saterland Frisian-language text\"><span lang=\"stq\">Seelterfräiske Wikipedia</span></span>"
    },
    "alt": {
        "english": "Southern Altai Wikipedia",
        "native": "<span title=\"Altay-language text\"><span lang=\"alt\">Тӱштӱк алтай Википедия</span></span>"
    },
    "srn": {
        "english": "Sranan Tongo Wikipedia",
        "native": "<span title=\"Sranan Tongo-language text\"><span lang=\"srn\">Sranan Wikipedia</span></span>"
    },
    "to": {
        "english": "Tongan Wikipedia",
        "native": "<span title=\"Tongan-language text\"><span lang=\"to\">Wikipedia ʻi lea fakatonga</span></span>"
    },
    "za": {
        "english": "Zhuang Wikipedia",
        "native": "<span title=\"Zhuang-language text\"><span lang=\"za\">Veizgiek Bakgoh Vahcuengh</span></span>"
    },
    "ksh": {
        "english": "Ripuarian Wikipedia",
        "native": "<span title=\"Kölsch-language text\"><span lang=\"ksh\">Wikkipedija en Ripoarisch Platt</span></span>"
    },
    "roa-rup": {
        "english": "Aromanian Wikipedia",
        "native": "<span title=\"Aromanian-language text\"><span lang=\"rup\">Wikipedia pri Armâneaști</span></span>"
    },
    "map-bms": {
        "english": "Banyumasan Wikipedia",
        "native": "<span title=\"Javanese-language text\"><span lang=\"jv\">Wikipédia basa Banyumasan</span></span>"
    },
    "krc": {
        "english": "Karachay-Balkar Wikipedia",
        "native": "<span title=\"Karachay-Balkar-language text\"><span lang=\"krc\">Къарачай-Малкъар Википедия</span></span>"
    },
    "ltg": {
        "english": "Latgalian Wikipedia",
        "native": "<span title=\"Latgalian-language text\"><span lang=\"ltg\">Vikipedeja latgaļu volūdā</span></span>"
    },
    "ln": {
        "english": "Lingala Wikipedia",
        "native": "<span title=\"Lingala-language text\"><span lang=\"ln\">Lingála Wikipedia</span></span>"
    },
    "sm": {
        "english": "Samoan Wikipedia",
        "native": "<span title=\"Samoan-language text\"><span lang=\"sm\">Wikipedia gagana Sāmoa</span></span>"
    },
    "tyv": {
        "english": "Tuvan Wikipedia",
        "native": "<span title=\"Tuvan-language text\"><span lang=\"tyv\">Тыва Википедия</span></span>"
    },
    "udm": {
        "english": "Udmurt Wikipedia",
        "native": "<span title=\"Udmurt-language text\"><span lang=\"udm\">Удмурт Википедия</span></span>"
    },
    "bm": {
        "english": "Bambara Wikipedia",
        "native": "<span title=\"Bambara-language text\"><span lang=\"bm\">Wikipedi Bamanankan</span></span>"
    },
    "wo": {
        "english": "Wolof Wikipedia",
        "native": "<span title=\"Wolof-language text\"><span lang=\"wo\">Wikipedia Wolof</span></span>"
    },
    "kl": {
        "english": "Greenlandic Wikipedia",
        "native": "<span title=\"Greenlandic-language text\"><span lang=\"kl\">Kalaallisut Wikipedia</span></span>"
    },
    "gcr": {
        "english": "Guianan Creole Wikipedia",
        "native": "<span title=\"Guianese Creole French-language text\"><span lang=\"gcr\">Wikipédja an kriyòl gwiyannen</span></span>"
    },
    "kg": {
        "english": "Kongo Wikipedia",
        "native": "<span title=\"Kongo-language text\"><span lang=\"kg\">Wikipedia kikôngo</span></span>"
    },
    "syl": {
        "english": "Sylheti Wikipedia"
    },
    "ti": {
        "english": "Tigrinya Wikipedia",
        "native": "<span title=\"Tigrinya-language text\"><span lang=\"ti\">ዊኪፐድያ ብትግርኛ</span></span>"
    },
    "bbc": {
        "english": "Toba Batak Wikipedia",
        "native": "<span title=\"Batak Toba-language text\"><span lang=\"bbc\">Wikipedia Batak Toba</span></span>"
    },
    "fat": {
        "english": "Fante Wikipedia",
        "native": "<span title=\"Fanti-language text\"><span lang=\"fat\">Fante Wikipedia</span></span>"
    },
    "mrj": {
        "english": "Hill Mari Wikipedia",
        "native": "<span title=\"Hill Mari-language text\"><span lang=\"mrj\">Кырык марла Википеди</span></span>"
    },
    "kge": {
        "english": "Komering Wikipedia",
        "native": "<span title=\"Komering-language text\"><span lang=\"kge\">Wikipidiya basa Kumoring</span></span>"
    },
    "ann": {
        "english": "Obolo Wikipedia",
        "native": "<span title=\"Obolo-language text\"><span lang=\"ann\">Wìkìpedia Usem Obolo</span></span>"
    },
    "pag": {
        "english": "Pangasinan Wikipedia",
        "native": "<span title=\"Pangasinan-language text\"><span lang=\"pag\">Wikipedia Pangasinan</span></span>"
    },
    "rsk": {
        "english": "Pannonian Rusyn Wikipedia",
        "native": "<span title=\"Pannonian Rusyn-language text\"><span lang=\"rsk\">Википедия на панонским руским язику</span></span>"
    },
    "sg": {
        "english": "Sango Wikipedia",
        "native": "<span title=\"Sango-language text\"><span lang=\"sg\">Wïkïpêdïyäa na Sängö</span></span>"
    },
    "trv": {
        "english": "Seediq Wikipedia",
        "native": "<span title=\"Sediq-language text\"><span lang=\"trv\">Seediq Wikipidiya</span></span>"
    },
    "tet": {
        "english": "Tetum Wikipedia",
        "native": "<span title=\"Tetum-language text\"><span lang=\"tet\">Wikipédia iha lia-tetun</span></span>"
    },
    "atj": {
        "english": "Atikamekw Wikipedia",
        "native": "<span title=\"Atikamekw-language text\"><span lang=\"atj\">Atikamekw Wikipetcia</span></span>"
    },
    "ch": {
        "english": "Chamorro Wikipedia",
        "native": "<span title=\"Chamorro-language text\"><span lang=\"ch\">Wikipedia Chamoru</span></span>"
    },
    "ik": {
        "english": "Iñupiaq Wikipedia",
        "native": "<span title=\"Inupiaq-language text\"><span lang=\"ik\">Uiqipitia Iñupiatun</span></span>"
    },
    "kbp": {
        "english": "Kabiye Wikipedia",
        "native": "<span title=\"Kabiyè-language text\"><span lang=\"kbp\">Wikipediya kabɩyɛ</span></span>"
    },
    "xal": {
        "english": "Kalmyk Wikipedia",
        "native": "<span title=\"Oirat-language text\"><span lang=\"xal\">Хальмг Бикипеди</span></span>"
    },
    "koi": {
        "english": "Komi-Permyak Wikipedia",
        "native": "<span title=\"Komi-Permyak-language text\"><span lang=\"koi\">Перем коми Википедия</span></span>"
    },
    "pfl": {
        "english": "Palatine German Wikipedia",
        "native": "<span title=\"Palatine German-language text\"><span lang=\"pfl\">Pälzisch Wikipedia</span></span>"
    },
    "pnt": {
        "english": "Pontic Wikipedia",
        "native": "<span title=\"Pontic-language text\"><span lang=\"pnt\">Ποντιακόν Βικιπαίδεια</span></span>"
    },
    "din": {
        "english": "Dinka Wikipedia",
        "native": "<span title=\"Dinka-language text\"><span lang=\"din\">Wikipedia Thuɔŋjäŋ</span></span>"
    },
    "fj": {
        "english": "Fijian Wikipedia",
        "native": "<span title=\"Fijian-language text\"><span lang=\"fj\">Vaka-Viti Wikipedia</span></span>"
    },
    "igl": {
        "english": "Igala Wikipedia",
        "native": "<span title=\"Igala-language text\"><span lang=\"igl\">Wikipídiya Igala</span></span>"
    },
    "kbd": {
        "english": "Kabardian Wikipedia",
        "native": "<span title=\"Kabardian-language text\"><span lang=\"kbd\">Адыгэбзэ Уикипедиэ</span></span>"
    },
    "nia": {
        "english": "Nias Wikipedia",
        "native": "<span title=\"Nias-language text\"><span lang=\"nia\">Wikipedia Li Niha</span></span>"
    },
    "tay": {
        "english": "Atayal Wikipedia",
        "native": "<span title=\"Atayal-language text\"><span lang=\"tay\">Wikibitia na Tayal</span></span>"
    },
    "pwn": {
        "english": "Paiwan Wikipedia",
        "native": "<span title=\"Paiwan-language text\"><span lang=\"pwn\">wikipidiya nua pinayuanan</span></span>"
    },
    "tdd": {
        "english": "Tai Nuea Wikipedia",
        "native": "<span title=\"Tai Nüa-language text\"><span lang=\"tdd\">ᥝᥤᥱ ᥑᥤᥱ ᥚᥤᥱ ᥖᥤᥱ ᥕᥣᥱ ᥖᥭᥰ ᥖᥬᥲ ᥑᥨᥒᥰ</span></span>"
    },
    "guc": {
        "english": "Wayuu Wikipedia",
        "native": "<span title=\"Wayuu-language text\"><span lang=\"guc\">Wikipeetia süka wayuunaiki</span></span>"
    },
    "bdr": {
        "english": "Bajau Sama Wikipedia",
        "native": "<span title=\"West Coast Bajau-language text\"><span lang=\"bdr\">Wikipidia Bajau Sama</span></span>"
    },
    "chy": {
        "english": "Cheyenne Wikipedia",
        "native": "<span title=\"Cheyenne-language text\"><span lang=\"chy\">Vekepete'a Tsėhésenėstsestȯtse</span></span>"
    },
    "ty": {
        "english": "Tahitian Wikipedia",
        "native": "<span title=\"Tahitian-language text\"><span lang=\"ty\">Vitipetia Reo Tahiti</span></span>"
    },
    "pi": {
        "english": "Pali Wikipedia",
        "native": "<span title=\"Pali-language text\"><span lang=\"pi\">पालि विकिपीडिया</span></span>"
    },
    "tig": {
        "english": "Tigre Wikipedia",
        "native": "<span title=\"Tigre-language text\"><span lang=\"tig\">ዊኪፒድያ ህግየ ትግሬ</span></span>"
    }
};
}
// -fin
