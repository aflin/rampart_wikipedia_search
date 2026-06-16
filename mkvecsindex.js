rampart.globalize(rampart.utils);

var Sql=require("rampart-sql");

var lc="en";
if(process.argv.length > 2 && process.argv[2].length)
    lc=process.argv[2];


var sql=new Sql.init(process.scriptPath + `/web_server/data/${lc}_wikipedia_search`);

// to set memory limit to, e.g., 80% of system memory
// For a single pass text index build on en wikipedia plan for about 35-40 gb
// otherwise it will automatically insert merge steps when it hits the limit
sql.set({indexMem: 80});

/*
  This statement creates the full text index on the Doc field.
 
  WITH WORDEXPRESSIONS:
  see: https://docs.thunderstone.com/site/texisman/index_options.html
  and  https://docs.thunderstone.com/site/texisman/creating_a_metamorph_index.html
  see also "addexp", which is the same as "WITH WORDEXPRESSIONS" 
    but in a separate statement: https://docs.thunderstone.com/site/texisman/indexing_properties.html
  
  the regular expressions used to define a word are not perlRE.  It is thunderstone's own rex:
  https://docs.thunderstone.com/site/texisman/rex_expression_syntax.html
  
  "metamorph inverted index" can also be replaced with "FULLTEXT"
  see: https://docs.thunderstone.com/site/vortexman/create_index_with_options.html
  
  INDEXMETER prints the progress of the index creation.
  
*/

// likep (full-text) index on the chunk Text
if(!sql.one("select * from SYSINDEX where NAME='wikivecs_Text_mmix'")) {
    printf("creating fulltext (likep) index on wikivecs(Text)\n");
    sql.exec(
      "create metamorph inverted index wikivecs_Text_mmix on wikivecs(Text) "+
      "WITH WORDEXPRESSIONS "+
      "('[\\alnum\\x80-\\xFF]{2,99}', '[\\alnum\\$%@\\-_\\+]{2,99}') "+
      "INDEXMETER 'on'");
} else {
    printf("fulltext index wikivecs_Text_mmix already exists, skipping\n");
}

// likev (vector similarity) index on the embedding column.
// vec_dtype 'f16': the embeddings are stored as fp16 (the embed() SQL function
// writes half-precision via embedTextToFp16Buf), so the index must read them as
// f16 -- the default dtype would misinterpret the bytes.
if(!sql.one("select * from SYSINDEX where NAME='wikivecs_Vec_vx'")) {
    printf("creating vector (likev) index on wikivecs(Vec)\n");
    sql.exec("create vector index wikivecs_Vec_vx on wikivecs(Vec) WITH INDEXMETER 'on' vec_dtype 'f16';");
} else {
    printf("vector index wikivecs_Vec_vx already exists, skipping\n");
}
