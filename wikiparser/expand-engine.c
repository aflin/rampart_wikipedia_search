/*
 * wiki-expand-engine.c — High-performance wikitext template expansion engine.
 *
 * This file is loaded as supportCode for a rampart-cmodule.
 * It provides all internal functions; the exportFunction is a thin wrapper.
 *
 * Architecture:
 *   - Zero-copy slice-based parsing (no allocation for splits)
 *   - rp_string growable buffers for output
 *   - C-side hash table for magic words and template cache
 *   - JS callback for template lookup (called once per unique template)
 *   - All parser functions implemented in C
 */

/*
 * Note: rampart.h (which includes rp_string.h) is included by cmodule
 * before this support code. rp_string functions are linked from the
 * rampart binary. We just need the standard C headers here.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <ctype.h>
#include <math.h>
#include <time.h>

/* Debug tracing — set to 1 to enable, 0 to disable */
#define PP_DEBUG 0


#if PP_DEBUG
#define DBG(fmt, ...) fprintf(stderr, fmt, ##__VA_ARGS__)
/* Debug: check for a specific string at a pipeline stage */
#define DBG_CHECK(label, buf, buflen, needle, nlen) do { \
    if (memmem((buf), (buflen), (needle), (nlen))) { \
        const char *_p = memmem((buf), (buflen), (needle), (nlen)); \
        int _off = (int)(_p - (buf)); \
        int _cs = _off > 40 ? _off - 40 : 0; \
        int _ce = _off + 40 < (buflen) ? _off + 40 : (buflen); \
        fprintf(stderr, "%s has '%s' at %d: ", (label), (needle), _off); \
        for (int _k = _cs; _k < _ce; _k++) \
            fputc(((unsigned char)(buf)[_k]) < 32 ? '.' : (buf)[_k], stderr); \
        fprintf(stderr, "\n"); \
    } \
} while(0)
/* Debug: count {| and |} in a buffer */
#define DBG_TABLE_BALANCE(label, buf, buflen) do { \
    int _to=0, _tc=0; \
    for(int _i=0; _i<(buflen)-1; _i++) { \
        if((buf)[_i]=='{' && (buf)[_i+1]=='|') _to++; \
        if((buf)[_i]=='|' && (buf)[_i+1]=='}') _tc++; \
    } \
    if (_to != _tc) fprintf(stderr, "%s: {|=%d |}=%d\n", (label), _to, _tc); \
} while(0)
#else
#define DBG(fmt, ...) ((void)0)
#define DBG_CHECK(label, buf, buflen, needle, nlen) ((void)0)
#define DBG_TABLE_BALANCE(label, buf, buflen) ((void)0)
#endif

/* From entities.c — linked from rampart binary */
extern size_t decode_html_entities_utf8(char *dest, const char *src);

/* ================================================================
   Origin map: tracks which bytes in flat text came from templates.
   Used by the debris filter to apply heuristics only to template output.
   ================================================================ */

typedef struct {
    uint8_t *bits;
    int      len;    /* number of bytes tracked */
} origin_map;

static origin_map *origin_map_new(int len) {
    origin_map *m = (origin_map *)malloc(sizeof(origin_map));
    int nbytes = (len + 7) / 8;
    m->bits = (uint8_t *)calloc(nbytes, 1);
    m->len = len;
    return m;
}

static void origin_map_free(origin_map *m) {
    if (m) { free(m->bits); free(m); }
}

static inline void origin_map_set(origin_map *m, int pos) {
    if (pos >= 0 && pos < m->len)
        m->bits[pos >> 3] |= (1 << (pos & 7));
}

static inline int origin_map_get(origin_map *m, int pos) {
    if (pos < 0 || pos >= m->len) return 0;
    return (m->bits[pos >> 3] >> (pos & 7)) & 1;
}

static int origin_map_any_in_range(origin_map *m, int start, int count) {
    for (int i = start; i < start + count && i < m->len; i++)
        if ((m->bits[i >> 3] >> (i & 7)) & 1) return 1;
    return 0;
}

/* ================================================================
   Slice: zero-copy reference into a string
   ================================================================ */

typedef struct {
    const char *ptr;
    int         len;
} slice_t;

static inline slice_t make_slice(const char *p, int len) {
    slice_t s = {p, len};
    return s;
}

static inline int slice_eq(slice_t a, const char *b, int blen) {
    return a.len == blen && memcmp(a.ptr, b, blen) == 0;
}

/* Case-insensitive comparison */
static inline int slice_ieq(slice_t a, const char *b, int blen) {
    if (a.len != blen) return 0;
    for (int i = 0; i < blen; i++) {
        if (tolower((unsigned char)a.ptr[i]) != tolower((unsigned char)b[i])) return 0;
    }
    return 1;
}

/* Trim whitespace from both ends of a slice */
static slice_t slice_trim(slice_t s) {
    while (s.len > 0 && (s.ptr[0] == ' ' || s.ptr[0] == '\t' ||
           s.ptr[0] == '\n' || s.ptr[0] == '\r')) {
        s.ptr++; s.len--;
    }
    while (s.len > 0 && (s.ptr[s.len-1] == ' ' || s.ptr[s.len-1] == '\t' ||
           s.ptr[s.len-1] == '\n' || s.ptr[s.len-1] == '\r')) {
        s.len--;
    }
    return s;
}

/* Find first occurrence of char in slice */
static int slice_chr(slice_t s, char c) {
    for (int i = 0; i < s.len; i++) {
        if (s.ptr[i] == c) return i;
    }
    return -1;
}

/* Check if slice starts with a string */
static inline int slice_starts(slice_t s, const char *pre, int prelen) {
    return s.len >= prelen && memcmp(s.ptr, pre, prelen) == 0;
}

/* ================================================================
   Hash table: simple chained hash for string keys
   ================================================================ */

#define HT_BUCKETS 4096

typedef struct ht_node {
    char           *key;
    int             klen;
    char           *val;
    int             vlen;
    struct ht_node *next;
} ht_node;

typedef struct {
    ht_node *buckets[HT_BUCKETS];
} hashtable_t;

static uint32_t ht_hash(const char *key, int klen) {
    uint32_t h = 5381;
    for (int i = 0; i < klen; i++)
        h = ((h << 5) + h) ^ (unsigned char)key[i];
    return h & (HT_BUCKETS - 1);
}

static void ht_init(hashtable_t *ht) {
    memset(ht->buckets, 0, sizeof(ht->buckets));
}

static void ht_free(hashtable_t *ht) {
    for (int i = 0; i < HT_BUCKETS; i++) {
        ht_node *n = ht->buckets[i];
        while (n) {
            ht_node *next = n->next;
            free(n->key);
            free(n->val);
            free(n);
            n = next;
        }
        ht->buckets[i] = NULL;
    }
}

static const char *ht_get(hashtable_t *ht, const char *key, int klen, int *vlen) {
    uint32_t h = ht_hash(key, klen);
    ht_node *n = ht->buckets[h];
    while (n) {
        if (n->klen == klen && memcmp(n->key, key, klen) == 0) {
            if (vlen) *vlen = n->vlen;
            return n->val;
        }
        n = n->next;
    }
    return NULL;
}

static void ht_set(hashtable_t *ht, const char *key, int klen,
                    const char *val, int vlen) {
    uint32_t h = ht_hash(key, klen);
    /* Check for existing entry */
    ht_node *n = ht->buckets[h];
    while (n) {
        if (n->klen == klen && memcmp(n->key, key, klen) == 0) {
            free(n->val);
            n->val = (char *)malloc(vlen + 1);
            memcpy(n->val, val, vlen);
            n->val[vlen] = '\0';
            n->vlen = vlen;
            return;
        }
        n = n->next;
    }
    /* New entry */
    n = (ht_node *)malloc(sizeof(ht_node));
    n->key = (char *)malloc(klen + 1);
    memcpy(n->key, key, klen);
    n->key[klen] = '\0';
    n->klen = klen;
    n->val = (char *)malloc(vlen + 1);
    memcpy(n->val, val, vlen);
    n->val[vlen] = '\0';
    n->vlen = vlen;
    n->next = ht->buckets[h];
    ht->buckets[h] = n;
}

/* ================================================================
   Expansion context
   ================================================================ */

#define MAX_DEPTH  30
#define MAX_CALLS  50000
#define MAX_SIZE   (2 * 1024 * 1024)
#define MAX_PARTS  256
#define MAX_SLICES 512

typedef struct {
    duk_context  *ctx;
    duk_idx_t     lookup_fn_idx;  /* stack index of JS lookup callback */

    hashtable_t   magic;          /* magic words */
    hashtable_t   tpl_cache;      /* C-side template cache */

    char          tpl_ns[128];    /* template namespace name */
    int           tpl_ns_len;

    int           max_depth;
    int           max_calls;
    double        max_ms;

    int           call_count;
    double        start_time;
} expand_ctx;

/* ================================================================
   Preprocessor node types and data structures.
   MediaWiki-style: parse braces into a tree, THEN expand.
   This prevents expanded content from corrupting brace matching.
   ================================================================ */

typedef enum { PP_TEXT, PP_TEMPLATE, PP_TPLARG } pp_node_type;

typedef struct {
    pp_node_type type;
    const char  *text_ptr;   /* PP_TEXT: zero-copy pointer into input */
    int          text_len;   /* PP_TEXT: length */
    int          parts_idx;  /* PP_TEMPLATE/PP_TPLARG: first index in parts[] */
    int          nparts;     /* PP_TEMPLATE/PP_TPLARG: number of pipe-delimited parts */
    int          next;       /* next sibling node index, or -1 */
} pp_node;

typedef struct {
    int first_child;         /* first node index in this part, or -1 */
    int last_child;          /* last node index (for O(1) append), or -1 */
} pp_part;

#define PP_INIT_NODES 256
#define PP_INIT_PARTS 128
#define PP_MAX_STACK  64

typedef struct {
    pp_node  *nodes;
    int       node_count;
    int       node_cap;
    pp_part  *parts;
    int       part_count;
    int       part_cap;
} pp_doc;

#define PP_MAX_FRAME_PARTS 256

typedef struct {
    int brace_count;     /* 2 or 3 */
    int input_pos;       /* position in input where braces started */
    int part_indices[PP_MAX_FRAME_PARTS]; /* actual indices of this frame's parts */
    int nparts;          /* number of parts accumulated */
} pp_stack_frame;

/* Forward declarations */
static void wiki_expand(expand_ctx *ec, const char *text, int len,
                        int depth, rp_string *out);
static void wiki_expand_with_params(expand_ctx *ec, const char *text, int len,
                                    hashtable_t *params, int depth, rp_string *out);
static void wiki_expand_part(expand_ctx *ec, pp_doc *doc, int part_idx,
                             hashtable_t *params, int depth, rp_string *out);
static void wiki_expand_node(expand_ctx *ec, pp_doc *doc, int node_idx,
                             hashtable_t *params, int depth, rp_string *out);
static void expand_single_template(expand_ctx *ec, const char *inner, int inner_len,
                                   int depth, rp_string *out);
static inline int at_line_start(const char *q, const char *base);
static const char *find_close_tag(const char *p, const char *end, const char *tag, int taglen);
static void strip_wiki_markup(const char *text, int len, rp_string *out,
                               const origin_map *in_origins, origin_map *out_origins,
                               int base_offset, int depth);
static void filter_debris(const char *text, int len, rp_string *out,
                           const origin_map *origins);

/* Check if limits are exceeded */
static inline int limits_exceeded(expand_ctx *ec) {
    if (ec->call_count >= ec->max_calls) return 1;
    /* Check time every 100 calls to reduce overhead */
    if ((ec->call_count & 0x7F) == 0) {
        double now;
        /* Use clock() as a lightweight timer */
        now = (double)clock() / CLOCKS_PER_SEC * 1000.0;
        /* Note: start_time was set using same clock source */
        /* Just use call_count as primary limiter */
    }
    return 0;
}

/* ================================================================
   Split on | respecting nesting
   Returns number of parts. Parts are slices into the original text.
   ================================================================ */

static int split_parts(const char *text, int len, slice_t *parts, int max_parts) {
    int _has_mf = (len > 10 && memmem(text, len, "<mapfr", 6) != NULL);
    int n = 0, depth = 0, bdepth = 0, sdepth = 0, start = 0;
    for (int i = 0; i < len && n < max_parts - 1; i++) {
        char c = text[i];
        if (c == '\x01') { sdepth++; continue; }
        if (c == '\x02') { if (sdepth > 0) sdepth--; continue; }
        /* Skip extension tags (<math>, <ref>, <nowiki>, etc.) whose content
           may contain }} or | that would corrupt depth/split logic. */
        if (c == '<' && i + 1 < len) {
            static const char *etags[] = {"math","ref","nowiki","syntaxhighlight","source",NULL};
            static const int   elens[] = {4,3,6,15,6};
            for (int et = 0; etags[et]; et++) {
                int elen = elens[et];
                if (i + 1 + elen < len &&
                    strncasecmp(text + i + 1, etags[et], elen) == 0) {
                    char nx = text[i + 1 + elen];
                    if (nx == '>' || nx == ' ' || nx == '/') {
                        /* Check for self-closing tag first */
                        const char *sc = text + i + 1;
                        int selfclose = 0;
                        while (sc < text + len && *sc != '>') {
                            if (*sc == '/' && sc + 1 < text + len && sc[1] == '>') {
                                selfclose = 1; i = (int)(sc - text) + 1; goto sp_next;
                            }
                            sc++;
                        }
                        if (sc < text + len && *sc == '>') {
                            const char *close = find_close_tag(sc + 1, text + len, etags[et], elen);
                            if (close) { i = (int)(close - text) - 1; goto sp_next; }
                        }
                    }
                }
            }
        }
        if (c == '{' && i + 1 < len && text[i+1] == '{') { depth++; i++; }
        else if (c == '}' && i + 1 < len && text[i+1] == '}') { depth--; i++; }
        else if (c == '[' && i + 1 < len && text[i+1] == '[') { bdepth++; i++; }
        else if (c == ']' && i + 1 < len && text[i+1] == ']') { bdepth--; i++; }
        else if (c == '|' && depth == 0 && bdepth == 0 && sdepth == 0) {
            if (_has_mf) DBG("SPLIT at %d: part[%d] = %.40s\n", i, n, text + start);
            parts[n++] = make_slice(text + start, i - start);
            start = i + 1;
        }
    sp_next:;
    }
    parts[n++] = make_slice(text + start, len - start);
    return n;
}

/* ================================================================
   Preprocessor: parse braces into a tree (MediaWiki-style).
   Single-pass, left-to-right, stack-based.

   Produces a tree of PP_TEXT / PP_TEMPLATE / PP_TPLARG nodes.
   Each template/tplarg has pipe-delimited parts.
   Expansion then walks this tree — braces in expanded content
   can never corrupt the parent tree's structure.
   ================================================================ */

static void pp_doc_init(pp_doc *doc) {
    doc->node_cap = PP_INIT_NODES;
    doc->node_count = 0;
    doc->nodes = (pp_node *)malloc(sizeof(pp_node) * doc->node_cap);
    doc->part_cap = PP_INIT_PARTS;
    doc->part_count = 0;
    doc->parts = (pp_part *)malloc(sizeof(pp_part) * doc->part_cap);
}

static void pp_doc_free(pp_doc *doc) {
    free(doc->nodes);
    free(doc->parts);
}

/* Allocate a node, growing array if needed. Returns index, or -1 on failure. */
static int pp_alloc_node(pp_doc *doc) {
    if (doc->node_count >= doc->node_cap) {
        int new_cap = doc->node_cap * 2;
        pp_node *p = (pp_node *)realloc(doc->nodes, sizeof(pp_node) * new_cap);
        if (!p) return -1;
        doc->nodes = p;
        doc->node_cap = new_cap;
    }
    int idx = doc->node_count++;
    doc->nodes[idx].next = -1;
    return idx;
}

/* Allocate a part, growing array if needed. Returns index, or -1 on failure. */
static int pp_alloc_part(pp_doc *doc) {
    if (doc->part_count >= doc->part_cap) {
        int new_cap = doc->part_cap * 2;
        pp_part *p = (pp_part *)realloc(doc->parts, sizeof(pp_part) * new_cap);
        if (!p) return -1;
        doc->parts = p;
        doc->part_cap = new_cap;
    }
    int idx = doc->part_count++;
    doc->parts[idx].first_child = -1;
    doc->parts[idx].last_child = -1;
    return idx;
}

/* Append a node to a part's child list. */
static void pp_append_node(pp_doc *doc, int part_idx, int node_idx) {
    if (part_idx < 0 || node_idx < 0) return;
    if (part_idx >= doc->part_count || node_idx >= doc->node_count) return;
    pp_part *part = &doc->parts[part_idx];
    doc->nodes[node_idx].next = -1;
    if (part->last_child >= 0) {
        doc->nodes[part->last_child].next = node_idx;
    } else {
        part->first_child = node_idx;
    }
    part->last_child = node_idx;
}

/* Emit a TEXT node into a part (coalesces with previous TEXT if adjacent). */
static void pp_emit_text(pp_doc *doc, int part_idx, const char *ptr, int len) {
    if (len <= 0 || part_idx < 0) return;
    /* Try to coalesce with the last node if it's a TEXT and adjacent */
    pp_part *part = &doc->parts[part_idx];
    if (part->last_child >= 0) {
        pp_node *last = &doc->nodes[part->last_child];
        if (last->type == PP_TEXT && last->text_ptr + last->text_len == ptr) {
            last->text_len += len;
            return;
        }
    }
    int idx = pp_alloc_node(doc);
    doc->nodes[idx].type = PP_TEXT;
    doc->nodes[idx].text_ptr = ptr;
    doc->nodes[idx].text_len = len;
    doc->nodes[idx].parts_idx = 0;
    doc->nodes[idx].nparts = 0;
    pp_append_node(doc, part_idx, idx);
}

/* Move all children from src_part to the end of dst_part. */
static void pp_move_children(pp_doc *doc, int dst_idx, int src_idx) {
    if (dst_idx < 0 || src_idx < 0) return;
    pp_part *dst = &doc->parts[dst_idx];
    pp_part *src = &doc->parts[src_idx];
    if (src->first_child < 0) return; /* nothing to move */
    if (dst->last_child >= 0) {
        doc->nodes[dst->last_child].next = src->first_child;
    } else {
        dst->first_child = src->first_child;
    }
    dst->last_child = src->last_child;
    src->first_child = -1;
    src->last_child = -1;
}

static void wiki_preprocess(const char *text, int len, pp_doc *doc) {
    pp_doc_init(doc);

    /* Root part at index 0 */
    int root_part = pp_alloc_part(doc);

    pp_stack_frame stack[PP_MAX_STACK];
    int stack_depth = 0;

    int current_part = root_part;
    int text_start = 0; /* start of current uncommitted text run */
    int bracket_depth = 0; /* [[...]] nesting — pipes inside links are NOT part separators */
    int i = 0;

    while (i < len) {
        char c = text[i];

        /* === Extension tags: <math>, <ref>, <nowiki> are opaque — braces
           inside them are not wikitext and must not affect brace matching.
           Handle both literal <math> and entity-encoded &lt;math&gt; forms. === */
        if ((c == '<' || c == '&') && i + 1 < len) {
            static const char *etags[] = {"math","ref","nowiki","syntaxhighlight","source",NULL};
            static const int   elens[] = {4,3,6,15,6};
            for (int et = 0; etags[et]; et++) {
                int elen = elens[et];
                if (c == '<' && i + 1 + elen < len &&
                    strncasecmp(text + i + 1, etags[et], elen) == 0) {
                    char nx = text[i + 1 + elen];
                    if (nx == '>' || nx == ' ' || nx == '/') {
                        /* Check for self-closing tag (<ref .../>) — just skip
                           past /> without searching for a closing tag */
                        int selfclose = 0;
                        {
                            const char *sc = text + i + 1;
                            while (sc < text + len && *sc != '>') {
                                if (*sc == '/' && sc + 1 < text + len && sc[1] == '>') {
                                    selfclose = 1;
                                    i = (int)(sc - text) + 2;
                                    break;
                                }
                                sc++;
                            }
                            if (!selfclose && sc < text + len && *sc == '>') {
                                /* Not self-closing — find the matching close tag */
                                const char *close = find_close_tag(sc + 1, text + len, etags[et], elen);
                                if (close) {
                                    i = (int)(close - text);
                                } else {
                                    i = (int)(sc - text) + 1;
                                }
                            } else if (!selfclose) {
                                while (i < len && text[i] != '>') i++;
                                if (i < len) i++;
                            }
                        }
                        goto pp_continue;
                    }
                }
                /* Entity form: &lt;math&gt; ... &lt;/math&gt; */
                if (c == '&' && i + 4 + elen < len &&
                    text[i+1]=='l' && text[i+2]=='t' && text[i+3]==';' &&
                    strncasecmp(text + i + 4, etags[et], elen) == 0) {
                    char nx = text[i + 4 + elen];
                    if (nx == '&' || nx == ' ') { /* &gt; or space (attributes) */
                        /* Find &lt;/tagname&gt; */
                        char close_pat[32];
                        int cplen = snprintf(close_pat, sizeof(close_pat), "&lt;/%s&gt;", etags[et]);
                        const char *close = NULL;
                        for (const char *s = text + i + 4 + elen; s + cplen <= text + len; s++) {
                            if (strncasecmp(s, close_pat, cplen) == 0) { close = s + cplen; break; }
                        }
                        if (close) {
                            i = (int)(close - text);
                        } else {
                            /* Find &gt; to skip the open tag */
                            while (i < len - 3 && !(text[i]=='&' && text[i+1]=='g' && text[i+2]=='t' && text[i+3]==';')) i++;
                            if (i + 4 <= len) i += 4;
                        }
                        goto pp_continue;
                    }
                }
            }
        }

        /* === Track [[...]] nesting (don't consume — leave in text run) === */
        if (c == '[' && i + 1 < len && text[i+1] == '[') {
            bracket_depth++;
            i += 2;
            continue;  /* chars stay in text run via text_start tracking */
        }
        if (c == ']' && i + 1 < len && text[i+1] == ']') {
            if (bracket_depth > 0) bracket_depth--;
            i += 2;
            continue;
        }

        /* === Opening braces === */
        if (c == '{') {
            int run_start = i;
            int brace_count = 0;
            while (i < len && text[i] == '{') { brace_count++; i++; }

            if (brace_count < 2) {
                /* Single { — just literal, keep scanning */
                continue;
            }

            /* Flush accumulated text before this brace run */
            if (run_start > text_start) {
                pp_emit_text(doc, current_part, text + text_start, run_start - text_start);
            }

            /* Push stack frames left-to-right.  Use 2-brace (template)
               pieces first; the RIGHTMOST (innermost) piece gets 3 braces
               when the total is odd.  This matches MediaWiki's behavior
               for patterns like {{{{{|safesubst:}}}...}} where the inner
               {{{ }}} is a tplarg wrapped by an outer {{ }}. */
            int remaining = brace_count;
            int pos = run_start;

            while (remaining >= 2 && stack_depth < PP_MAX_STACK) {
                int use;
                if (remaining == 3) {
                    use = 3;  /* last piece, odd → tplarg */
                } else {
                    use = 2;
                }

                int part = pp_alloc_part(doc);

                stack[stack_depth].brace_count = use;
                stack[stack_depth].input_pos = pos;
                stack[stack_depth].part_indices[0] = part;
                stack[stack_depth].nparts = 1;
                stack_depth++;

                current_part = part;
                pos += use;
                remaining -= use;
            }

            /* Any remaining single { is literal */
            if (remaining == 1) {
                pp_emit_text(doc, current_part, text + pos, 1);
            }

            text_start = i; /* past the brace run */
            continue;
        }

        /* === Closing braces === */
        if (c == '}') {
            int run_start = i;
            int brace_count = 0;
            while (i < len && text[i] == '}') { brace_count++; i++; }

            if (brace_count < 2 || stack_depth == 0) {
                /* Can't match — treat as literal, keep in text run */
                continue;
            }

            /* Flush accumulated text before this brace run */
            if (run_start > text_start) {
                pp_emit_text(doc, current_part, text + text_start, run_start - text_start);
            }

            int remaining = brace_count;

            while (remaining >= 2 && stack_depth > 0) {
                pp_stack_frame *frame = &stack[stack_depth - 1];

                int use;
                pp_node_type ntype;
                if (frame->brace_count == 3 && remaining >= 3) {
                    use = 3; ntype = PP_TPLARG;
                } else if (frame->brace_count >= 2 && remaining >= 2) {
                    use = 2; ntype = PP_TEMPLATE;
                } else {
                    break; /* can't match */
                }

                int excess_open = frame->brace_count - use;

                /* Compact this frame's parts to contiguous locations.
                   Nested frames may have allocated parts in between,
                   so the frame's part_indices[] may be non-contiguous. */
                int compact_start = doc->part_count;
                for (int fp = 0; fp < frame->nparts; fp++) {
                    int new_idx = pp_alloc_part(doc);
                    doc->parts[new_idx] = doc->parts[frame->part_indices[fp]];
                }

                int node_idx = pp_alloc_node(doc);
                doc->nodes[node_idx].type = ntype;
                doc->nodes[node_idx].text_ptr = NULL;
                doc->nodes[node_idx].text_len = 0;
                doc->nodes[node_idx].parts_idx = compact_start;
                doc->nodes[node_idx].nparts = frame->nparts;

                /* Pop the stack frame */
                stack_depth--;

                /* Determine parent part (last part of parent frame) */
                int parent_part;
                if (stack_depth > 0) {
                    pp_stack_frame *pf = &stack[stack_depth - 1];
                    parent_part = pf->part_indices[pf->nparts - 1];
                } else {
                    parent_part = root_part;
                }

                /* Emit excess opening braces as literal before this node */
                if (excess_open > 0) {
                    pp_emit_text(doc, parent_part, text + frame->input_pos, excess_open);
                }

                /* Attach this node to the parent's current part */
                pp_append_node(doc, parent_part, node_idx);

                current_part = parent_part;
                remaining -= use;
            }

            /* Any remaining closing braces are literal */
            if (remaining > 0) {
                pp_emit_text(doc, current_part, text + (i - remaining), remaining);
            }

            text_start = i;
            continue;
        }

        /* === Pipe inside a brace frame (but not inside [[link|display]]) === */
        if (c == '|' && stack_depth > 0 && bracket_depth == 0) {
            /* Flush accumulated text */
            if (i > text_start) {
                pp_emit_text(doc, current_part, text + text_start, i - text_start);
            }

            /* Start a new part in the top stack frame */
            pp_stack_frame *frame = &stack[stack_depth - 1];
            int new_part = pp_alloc_part(doc);
            if (frame->nparts < PP_MAX_FRAME_PARTS) {
                frame->part_indices[frame->nparts] = new_part;
                frame->nparts++;
            }
            current_part = new_part;

            text_start = i + 1;
            i++;
            continue;
        }

        /* Regular character — just advance */
        i++;
    pp_continue:;
    }

    /* Flush remaining text */
    if (i > text_start) {
        pp_emit_text(doc, current_part, text + text_start, i - text_start);
    }

    /* Unwind any unclosed stack frames — their braces become literal text.
       Move their children back into the parent part. */
    while (stack_depth > 0) {
        pp_stack_frame *frame = &stack[stack_depth - 1];
        stack_depth--;

        int parent_part;
        if (stack_depth > 0) {
            pp_stack_frame *pf = &stack[stack_depth - 1];
            parent_part = pf->part_indices[pf->nparts - 1];
        } else {
            parent_part = root_part;
        }

        /* Emit the opening braces as literal text */
        pp_emit_text(doc, parent_part, text + frame->input_pos, frame->brace_count);

        /* Move all parts' children into parent, with | literals between parts */
        for (int p = 0; p < frame->nparts; p++) {
            int pidx = frame->part_indices[p];
            if (p > 0) {
                /* Emit a literal | for the pipe that separated this part */
                /* Find the | in the original text — it's somewhere between parts.
                   Since we can't easily recover the exact position, emit a synthetic |. */
                static const char pipe_char = '|';
                pp_emit_text(doc, parent_part, &pipe_char, 1);
            }
            pp_move_children(doc, parent_part, pidx);
        }

        current_part = parent_part;
    }
}

/* ================================================================
   Serialize with tplarg resolution: convert a preprocessor tree
   part back to text, resolving PP_TPLARG nodes against params.
   PP_TEMPLATE nodes are kept as raw {{...}} text.

   This is equivalent to the old substitute_params: it replaces
   {{{param}}} with values before the text is processed further.
   ================================================================ */

static void wiki_resolve_part(expand_ctx *ec, pp_doc *doc, int part_idx,
                              hashtable_t *params, int depth, rp_string *out);

static void wiki_resolve_node(expand_ctx *ec, pp_doc *doc, int node_idx,
                              hashtable_t *params, int depth, rp_string *out) {
    if (node_idx < 0) return;
    pp_node *node = &doc->nodes[node_idx];
    switch (node->type) {
    case PP_TEXT:
        rp_string_putsn(out, node->text_ptr, node->text_len);
        break;
    case PP_TEMPLATE:
        /* Keep templates as raw text — they'll be expanded later */
        rp_string_putsn(out, "{{", 2);
        for (int p = 0; p < node->nparts; p++) {
            if (p > 0) rp_string_putc(out, '|');
            wiki_resolve_part(ec, doc, node->parts_idx + p, params, depth, out);
        }
        rp_string_putsn(out, "}}", 2);
        break;
    case PP_TPLARG: {
        /* Resolve the tplarg — substitute the parameter value.
           This is the tree-based equivalent of substitute_params. */
        rp_string *name_buf = rp_string_new(64);
        if (node->nparts > 0) {
            wiki_resolve_part(ec, doc, node->parts_idx, params, depth + 1, name_buf);
        }
        /* Trim name */
        const char *np = name_buf->str;
        int nlen = (int)name_buf->len;
        while (nlen > 0 && (*np == ' ' || *np == '\t' || *np == '\n')) { np++; nlen--; }
        while (nlen > 0 && (np[nlen-1] == ' ' || np[nlen-1] == '\t' || np[nlen-1] == '\n')) nlen--;

        int vlen = 0;
        const char *val = params ? ht_get(params, np, nlen, &vlen) : NULL;
        if (val) {
            /* Found — emit the raw value. The value may itself contain
               templates ({{...}}) which will be expanded when expand_single_template
               processes the reconstructed text. */
            rp_string_putsn(out, val, vlen);
        } else if (node->nparts >= 2) {
            /* Default value — resolve it (may contain nested tplargs) */
            wiki_resolve_part(ec, doc, node->parts_idx + 1, params, depth + 1, out);
        }
        /* No value and no default → output nothing */
        rp_string_free(name_buf);
        break;
    }
    }
}

static void wiki_resolve_part(expand_ctx *ec, pp_doc *doc, int part_idx,
                              hashtable_t *params, int depth, rp_string *out) {
    if (part_idx < 0 || part_idx >= doc->part_count) return;
    int node_idx = doc->parts[part_idx].first_child;
    while (node_idx >= 0 && node_idx < doc->node_count) {
        wiki_resolve_node(ec, doc, node_idx, params, depth, out);
        node_idx = doc->nodes[node_idx].next;
    }
}

/* ================================================================
   Phase 2: Expand the preprocessor tree.

   Walks the node tree produced by wiki_preprocess().
   PP_TEXT → emit literal text
   PP_TPLARG → look up parameter, expand value
   PP_TEMPLATE → call expand_single_template
   ================================================================ */

static void wiki_expand_node(expand_ctx *ec, pp_doc *doc, int node_idx,
                             hashtable_t *params, int depth, rp_string *out) {
    if (node_idx < 0) return;
    pp_node *node = &doc->nodes[node_idx];

    /* Always emit text nodes. Only check limits for template/tplarg expansion. */
    switch (node->type) {
    case PP_TEXT:
        if (node->text_len > 5 && memmem(node->text_ptr, node->text_len, "<mapf", 5))
            DBG("EMIT PP_TEXT with <mapf at depth=%d len=%d: %.80s\n", depth, node->text_len, node->text_ptr);
        rp_string_putsn(out, node->text_ptr, node->text_len);
        break;

    case PP_TPLARG: {
        if (depth >= ec->max_depth || limits_exceeded(ec)) break;
        /* {{{name|default}}} — resolve template argument */
        /* Expand part 0 to get the parameter name */
        rp_string *name_buf = rp_string_new(128);
        if (node->nparts > 0) {
            wiki_expand_part(ec, doc, node->parts_idx, params, depth + 1, name_buf);
        }
        /* Trim the name */
        const char *np = name_buf->str;
        int nlen = (int)name_buf->len;
        while (nlen > 0 && (*np == ' ' || *np == '\t' || *np == '\n')) { np++; nlen--; }
        while (nlen > 0 && (np[nlen-1] == ' ' || np[nlen-1] == '\t' || np[nlen-1] == '\n')) nlen--;

        /* Look up in params */
        int vlen = 0;
        const char *val = params ? ht_get(params, np, nlen, &vlen) : NULL;

        if (val) {
            /* Parameter found — expand the raw value (it may contain templates) */
            wiki_expand(ec, val, vlen, depth + 1, out);
        } else if (node->nparts >= 2) {
            /* Has default value — expand part 1 in current context */
            wiki_expand_part(ec, doc, node->parts_idx + 1, params, depth + 1, out);
        }
        /* If no value and no default, output nothing (matches MediaWiki for
           template params). Undefined params in article-level text are rare
           and should produce nothing. */

        rp_string_free(name_buf);
        break;
    }

    case PP_TEMPLATE: {
        if (depth >= ec->max_depth || limits_exceeded(ec)) break;
        /* {{name|arg1|arg2|...}} — expand template call */
        rp_string *inner = rp_string_new(256);

        for (int p = 0; p < node->nparts; p++) {
            if (p > 0) rp_string_putc(inner, '|');
            int pidx = node->parts_idx + p;
            if (pidx < doc->part_count) {
                wiki_resolve_part(ec, doc, pidx, params, depth, inner);
            }
        }

        /* Sentinel-wrap the template output */
        size_t before_len = out->len;
        rp_string_putc(out, '\x01');
        expand_single_template(ec, inner->str, (int)inner->len, depth, out);

        /* Strip unclosed <!-- in expansion output by removing just the
           <!-- marker (4 bytes), not truncating everything after it.
           Pass 3's comment handler will pair remaining <!-- with --> . */
        {
            char *seg = out->str + before_len;
            int seg_len = (int)(out->len - before_len);
            int last_open = -1, last_close = -1;
            for (int k = 0; k < seg_len - 3; k++) {
                if (seg[k] == '<' && seg[k+1] == '!' &&
                    seg[k+2] == '-' && seg[k+3] == '-') {
                    last_open = k;
                }
                if (k < seg_len - 2 &&
                    seg[k] == '-' && seg[k+1] == '-' && seg[k+2] == '>') {
                    last_close = k;
                }
            }
            if (last_open >= 0 && last_open > last_close) {
                /* Neutralize the unclosed <!-- by replacing < with space */
                seg[last_open] = ' ';
            }
        }
        rp_string_putc(out, '\x02');

        rp_string_free(inner);
        break;
    }
    }
}

static void wiki_expand_part(expand_ctx *ec, pp_doc *doc, int part_idx,
                             hashtable_t *params, int depth, rp_string *out) {
    if (part_idx < 0 || part_idx >= doc->part_count) return;
    int node_idx = doc->parts[part_idx].first_child;
    while (node_idx >= 0 && node_idx < doc->node_count) {
        wiki_expand_node(ec, doc, node_idx, params, depth, out);
        node_idx = doc->nodes[node_idx].next;
    }
}

static void wiki_expand_with_params(expand_ctx *ec, const char *text, int len,
                                    hashtable_t *params, int depth, rp_string *out) {
    if (depth >= ec->max_depth || limits_exceeded(ec) || len <= 0) {
        rp_string_putsn(out, text, len);
        return;
    }
    if ((int)out->len + len > MAX_SIZE) {
        rp_string_putsn(out, text, len);
        return;
    }

    pp_doc doc;
    wiki_preprocess(text, len, &doc);
    wiki_expand_part(ec, &doc, 0 /* root part */, params, depth, out);
    pp_doc_free(&doc);
}

static void wiki_expand(expand_ctx *ec, const char *text, int len,
                        int depth, rp_string *out) {
    wiki_expand_with_params(ec, text, len, NULL, depth, out);
}

/* ================================================================
   Template lookup via JS callback
   ================================================================ */

static const char *lookup_template(expand_ctx *ec, const char *name, int name_len,
                                   int *out_len) {
    /* Check C-side cache */
    const char *cached = ht_get(&ec->tpl_cache, name, name_len, out_len);
    if (cached) return cached;

    /* Build full template name with namespace prefix if needed */
    int has_colon = 0;
    for (int i = 0; i < name_len; i++) {
        if (name[i] == ':') { has_colon = 1; break; }
    }

    /* Call JS callback */
    duk_dup(ec->ctx, ec->lookup_fn_idx);
    if (!has_colon && ec->tpl_ns_len > 0) {
        /* Prepend template namespace: "Modèle:Name" */
        rp_string *fullname = rp_string_new(ec->tpl_ns_len + 1 + name_len + 1);
        rp_string_putsn(fullname, ec->tpl_ns, ec->tpl_ns_len);
        rp_string_putc(fullname, ':');
        rp_string_putsn(fullname, name, name_len);
        duk_push_lstring(ec->ctx, fullname->str, fullname->len);
        rp_string_free(fullname);
    } else {
        duk_push_lstring(ec->ctx, name, name_len);
    }
    duk_call(ec->ctx, 1);

    duk_size_t rlen;
    const char *result = duk_get_lstring(ec->ctx, -1, &rlen);
    if (!result) { rlen = 0; result = ""; }

    /* Cache in C (copy since Duktape may GC) */
    ht_set(&ec->tpl_cache, name, name_len, result, (int)rlen);
    duk_pop(ec->ctx);

    return ht_get(&ec->tpl_cache, name, name_len, out_len);
}

/* ================================================================
   Magic word lookup
   ================================================================ */

static const char *get_magic_word(expand_ctx *ec, const char *name, int nlen, int *vlen) {
    /* Try as-is first (handles "!" and "=") */
    const char *v = ht_get(&ec->magic, name, nlen, vlen);
    if (v) return v;

    /* Try uppercase */
    char upper[256];
    if (nlen < (int)sizeof(upper)) {
        for (int i = 0; i < nlen; i++)
            upper[i] = toupper((unsigned char)name[i]);
        v = ht_get(&ec->magic, upper, nlen, vlen);
        if (v) return v;
    }

    return NULL;
}

/* ================================================================
   Parser functions
   ================================================================ */

/* Expand a slice into an rp_string, used for lazy evaluation */
static void expand_slice(expand_ctx *ec, slice_t s, int depth, rp_string *out) {
    wiki_expand(ec, s.ptr, s.len, depth, out);
}

/* Expand slice, trim result, return as slice into the rp_string */
static slice_t expand_and_trim(expand_ctx *ec, slice_t s, int depth, rp_string *buf) {
    rp_string_clear(buf);
    wiki_expand(ec, s.ptr, s.len, depth, buf);
    /* Trim in place */
    const char *p = buf->str;
    int len = (int)buf->len;
    while (len > 0 && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) { p++; len--; }
    while (len > 0 && (p[len-1] == ' ' || p[len-1] == '\t' || p[len-1] == '\n' || p[len-1] == '\r')) len--;
    return make_slice(p, len);
}

/* Simple expression evaluator for #expr and #ifexpr */
/* Forward declarations for recursive descent */
typedef struct { const char *p; const char *end; } expr_state;
static double expr_parse(expr_state *es);
static double expr_or(expr_state *es);

static void expr_skip_ws(expr_state *es) {
    while (es->p < es->end && (*es->p == ' ' || *es->p == '\t')) es->p++;
}

static double expr_number(expr_state *es) {
    expr_skip_ws(es);
    if (es->p >= es->end) return 0;

    /* Unary minus/plus */
    int neg = 0;
    while (es->p < es->end && (*es->p == '-' || *es->p == '+')) {
        if (*es->p == '-') neg = !neg;
        es->p++;
        expr_skip_ws(es);
    }

    double val = 0;
    if (es->p < es->end && *es->p == '(') {
        es->p++;
        val = expr_or(es);
        expr_skip_ws(es);
        if (es->p < es->end && *es->p == ')') es->p++;
    } else if (es->p + 4 <= es->end && strncmp(es->p, "ceil", 4) == 0 && !isalpha((unsigned char)es->p[4])) {
        es->p += 4; val = ceil(expr_number(es));
    } else if (es->p + 5 <= es->end && strncmp(es->p, "floor", 5) == 0 && !isalpha((unsigned char)es->p[5])) {
        es->p += 5; val = floor(expr_number(es));
    } else if (es->p + 5 <= es->end && strncmp(es->p, "trunc", 5) == 0 && !isalpha((unsigned char)es->p[5])) {
        es->p += 5; val = trunc(expr_number(es));
    } else if (es->p + 3 <= es->end && strncmp(es->p, "abs", 3) == 0 && !isalpha((unsigned char)es->p[3])) {
        es->p += 3; val = fabs(expr_number(es));
    } else if (es->p + 3 <= es->end && strncmp(es->p, "exp", 3) == 0 && !isalpha((unsigned char)es->p[3])) {
        es->p += 3; val = exp(expr_number(es));
    } else if (es->p + 2 <= es->end && strncmp(es->p, "ln", 2) == 0 && !isalpha((unsigned char)es->p[2])) {
        es->p += 2; val = log(expr_number(es));
    } else if (es->p + 3 <= es->end && strncmp(es->p, "sin", 3) == 0 && !isalpha((unsigned char)es->p[3])) {
        es->p += 3; val = sin(expr_number(es));
    } else if (es->p + 3 <= es->end && strncmp(es->p, "cos", 3) == 0 && !isalpha((unsigned char)es->p[3])) {
        es->p += 3; val = cos(expr_number(es));
    } else if (es->p + 3 <= es->end && strncmp(es->p, "tan", 3) == 0 && !isalpha((unsigned char)es->p[3])) {
        es->p += 3; val = tan(expr_number(es));
    } else if (es->p + 2 <= es->end && strncmp(es->p, "pi", 2) == 0 && !isalpha((unsigned char)es->p[2])) {
        es->p += 2; val = 3.14159265358979323846;
    } else if (es->p + 1 <= es->end && *es->p == 'e' && (es->p+1 >= es->end || !isalpha((unsigned char)es->p[1]))) {
        es->p++; val = 2.71828182845904523536;
    } else {
        /* Parse number */
        char *endp;
        val = strtod(es->p, &endp);
        if (endp == es->p) return 0; /* not a number */
        es->p = endp;
    }
    return neg ? -val : val;
}

static double expr_pow(expr_state *es) {
    double val = expr_number(es);
    expr_skip_ws(es);
    if (es->p < es->end && *es->p == '^') {
        es->p++;
        val = pow(val, expr_pow(es)); /* right-associative */
    }
    return val;
}

static double expr_mul(expr_state *es) {
    double val = expr_pow(es);
    while (1) {
        expr_skip_ws(es);
        if (es->p >= es->end) break;
        if (*es->p == '*') { es->p++; val *= expr_pow(es); }
        else if (*es->p == '/' || (es->p + 3 <= es->end && strncmp(es->p, "div", 3) == 0)) {
            if (*es->p == '/') es->p++; else es->p += 3;
            double d = expr_pow(es);
            val = (d != 0) ? val / d : 0;
        }
        else if (es->p + 3 <= es->end && strncmp(es->p, "mod", 3) == 0) {
            es->p += 3;
            double d = expr_pow(es);
            val = (d != 0) ? fmod(val, d) : 0;
        }
        else break;
    }
    return val;
}

static double expr_add(expr_state *es) {
    double val = expr_mul(es);
    while (1) {
        expr_skip_ws(es);
        if (es->p >= es->end) break;
        if (*es->p == '+') { es->p++; val += expr_mul(es); }
        else if (*es->p == '-') { es->p++; val -= expr_mul(es); }
        else break;
    }
    return val;
}

static double expr_cmp(expr_state *es) {
    double val = expr_add(es);
    while (1) {
        expr_skip_ws(es);
        if (es->p >= es->end) break;
        if (es->p + 1 < es->end && es->p[0] == '<' && es->p[1] == '=') { es->p += 2; val = (val <= expr_add(es)) ? 1 : 0; }
        else if (es->p + 1 < es->end && es->p[0] == '>' && es->p[1] == '=') { es->p += 2; val = (val >= expr_add(es)) ? 1 : 0; }
        else if (es->p + 1 < es->end && es->p[0] == '!' && es->p[1] == '=') { es->p += 2; val = (val != expr_add(es)) ? 1 : 0; }
        else if (es->p + 1 < es->end && es->p[0] == '=' && es->p[1] == '=') { es->p += 2; val = (val == expr_add(es)) ? 1 : 0; }
        else if (*es->p == '<') { es->p++; val = (val < expr_add(es)) ? 1 : 0; }
        else if (*es->p == '>') { es->p++; val = (val > expr_add(es)) ? 1 : 0; }
        else break;
    }
    return val;
}

static double expr_and(expr_state *es) {
    double val = expr_cmp(es);
    while (1) {
        expr_skip_ws(es);
        if (es->p + 3 <= es->end && strncmp(es->p, "and", 3) == 0) {
            es->p += 3;
            double r = expr_cmp(es);
            val = (val && r) ? 1 : 0;
        } else break;
    }
    return val;
}

static double expr_or(expr_state *es) {
    double val = expr_and(es);
    while (1) {
        expr_skip_ws(es);
        if (es->p + 2 <= es->end && strncmp(es->p, "or", 2) == 0 &&
            (es->p + 2 >= es->end || !isalpha((unsigned char)es->p[2]))) {
            es->p += 2;
            double r = expr_and(es);
            val = (val || r) ? 1 : 0;
        } else break;
    }
    return val;
}

static double eval_expr_str(const char *s, int len) {
    expr_state es = { s, s + len };
    return expr_or(&es);
}

/* Format a number result */
static void format_number(double val, rp_string *out) {
    if (val == floor(val) && fabs(val) < 1e15) {
        rp_string_appendf(out, "%.0f", val);
    } else {
        rp_string_appendf(out, "%g", val);
    }
}

/* formatnum: add thousands separators */
static void format_num_str(const char *s, int slen, rp_string *out) {
    /* Find the integer part */
    int start = 0;
    if (slen > 0 && s[0] == '-') { rp_string_putc(out, '-'); start = 1; }

    /* Find decimal point */
    int dot = -1;
    for (int i = start; i < slen; i++) {
        if (s[i] == '.') { dot = i; break; }
    }
    int int_end = (dot >= 0) ? dot : slen;
    int int_len = int_end - start;

    /* Add integer part with commas */
    for (int i = 0; i < int_len; i++) {
        if (i > 0 && (int_len - i) % 3 == 0) rp_string_putc(out, ',');
        rp_string_putc(out, s[start + i]);
    }

    /* Add decimal part */
    if (dot >= 0) {
        rp_string_putsn(out, s + dot, slen - dot);
    }
}

/*
   Call a parser function. Returns 1 if handled, 0 if not recognized.
   Result is appended to `out`.
*/
static int call_parser_function(expand_ctx *ec, slice_t funcname,
                                slice_t *args, int nargs,
                                int depth, rp_string *out) {
    rp_string *buf1 = rp_string_new(256);
    rp_string *buf2 = rp_string_new(256);
    int handled = 1;

    /* Lowercase the function name for comparison */
    char fname[64];
    int flen = funcname.len < 63 ? funcname.len : 63;
    for (int i = 0; i < flen; i++) fname[i] = tolower((unsigned char)funcname.ptr[i]);
    fname[flen] = '\0';

    if (strcmp(fname, "#if") == 0) {
        slice_t test = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        if (test.len > 0) {
            if (nargs > 1) expand_slice(ec, args[1], depth + 1, out);
        } else {
            if (nargs > 2) expand_slice(ec, args[2], depth + 1, out);
        }
    }
    else if (strcmp(fname, "#ifeq") == 0) {
        slice_t lval = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        slice_t rval = (nargs > 1) ? expand_and_trim(ec, args[1], depth + 1, buf2) : make_slice("", 0);
        int eq = (lval.len == rval.len && memcmp(lval.ptr, rval.ptr, lval.len) == 0);
        /* Also try numeric comparison */
        if (!eq && lval.len > 0 && rval.len > 0) {
            char *e1, *e2;
            char tmp1[64], tmp2[64];
            int l1 = lval.len < 63 ? lval.len : 63;
            int l2 = rval.len < 63 ? rval.len : 63;
            memcpy(tmp1, lval.ptr, l1); tmp1[l1] = '\0';
            memcpy(tmp2, rval.ptr, l2); tmp2[l2] = '\0';
            double n1 = strtod(tmp1, &e1);
            double n2 = strtod(tmp2, &e2);
            if (e1 != tmp1 && e2 != tmp2 && *e1 == '\0' && *e2 == '\0')
                eq = (n1 == n2);
        }
        if (eq) {
            if (nargs > 2) expand_slice(ec, args[2], depth + 1, out);
        } else {
            if (nargs > 3) expand_slice(ec, args[3], depth + 1, out);
        }
    }
    else if (strcmp(fname, "#switch") == 0) {
        slice_t primary = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        int found = 0;
        slice_t default_val = {NULL, 0};

        for (int i = 1; i < nargs; i++) {
            /* Split on first = */
            int eqpos = -1;
            int d = 0;
            for (int k = 0; k < args[i].len; k++) {
                char c = args[i].ptr[k];
                if (c == '{' && k+1 < args[i].len && args[i].ptr[k+1] == '{') { d++; k++; }
                else if (c == '}' && k+1 < args[i].len && args[i].ptr[k+1] == '}') { d--; k++; }
                else if (c == '=' && d == 0) { eqpos = k; break; }
            }

            if (eqpos >= 0) {
                slice_t case_val = make_slice(args[i].ptr, eqpos);
                rp_string_clear(buf2);
                wiki_expand(ec, case_val.ptr, case_val.len, depth + 1, buf2);
                slice_t cv = slice_trim(make_slice(buf2->str, buf2->len));

                slice_t result_val = make_slice(args[i].ptr + eqpos + 1, args[i].len - eqpos - 1);

                if (found || (cv.len == primary.len && memcmp(cv.ptr, primary.ptr, cv.len) == 0)) {
                    expand_slice(ec, result_val, depth + 1, out);
                    goto switch_done;
                }
                if (slice_eq(cv, "#default", 8)) {
                    default_val = result_val;
                }
            } else {
                /* Fall-through case (no =) */
                rp_string_clear(buf2);
                wiki_expand(ec, args[i].ptr, args[i].len, depth + 1, buf2);
                slice_t cv = slice_trim(make_slice(buf2->str, buf2->len));
                if (cv.len == primary.len && memcmp(cv.ptr, primary.ptr, cv.len) == 0) {
                    found = 1;
                }
            }
        }
        /* Default */
        if (default_val.ptr) {
            expand_slice(ec, default_val, depth + 1, out);
        }
        switch_done: ;
    }
    else if (strcmp(fname, "#expr") == 0) {
        slice_t val = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        if (val.len > 0) {
            double r = eval_expr_str(val.ptr, val.len);
            format_number(r, out);
        }
    }
    else if (strcmp(fname, "#ifexpr") == 0) {
        slice_t val = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        double r = (val.len > 0) ? eval_expr_str(val.ptr, val.len) : 0;
        if (r != 0) {
            if (nargs > 1) expand_slice(ec, args[1], depth + 1, out);
        } else {
            if (nargs > 2) expand_slice(ec, args[2], depth + 1, out);
        }
    }
    else if (strcmp(fname, "#ifexist") == 0) {
        /* Always take the "does not exist" branch — we can't check LMDB from C easily */
        if (nargs > 2) expand_slice(ec, args[2], depth + 1, out);
        else if (nargs > 1) expand_slice(ec, args[1], depth + 1, out);
    }
    else if (strcmp(fname, "#iferror") == 0) {
        rp_string_clear(buf1);
        if (nargs > 0) expand_slice(ec, args[0], depth + 1, buf1);
        int is_error = (memmem(buf1->str, buf1->len, "class=\"error\"", 13) != NULL);
        if (is_error) {
            if (nargs > 1) expand_slice(ec, args[1], depth + 1, out);
        } else {
            if (nargs > 2) expand_slice(ec, args[2], depth + 1, out);
            else rp_string_putsn(out, buf1->str, buf1->len);
        }
    }
    else if (strcmp(fname, "#invoke") == 0) {
        /* Lua modules — can't execute */
    }
    else if (strcmp(fname, "#time") == 0 || strcmp(fname, "#timel") == 0 ||
             strcmp(fname, "#dateformat") == 0 || strcmp(fname, "#formatdate") == 0) {
        /* Simplified: just return the date argument or empty */
        if (nargs > 1) {
            slice_t date = expand_and_trim(ec, args[1], depth + 1, buf1);
            rp_string_putsn(out, date.ptr, date.len);
        }
    }
    else if (strcmp(fname, "#titleparts") == 0) {
        slice_t tp = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        /* Simple: just return the title as-is */
        rp_string_putsn(out, tp.ptr, tp.len);
    }
    else if (strcmp(fname, "#tag") == 0) {
        slice_t tagname = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        if (tagname.len > 0) {
            rp_string_putc(out, '<');
            rp_string_putsn(out, tagname.ptr, tagname.len);
            rp_string_putc(out, '>');
            if (nargs > 1) expand_slice(ec, args[1], depth + 1, out);
            rp_string_puts(out, "</");
            rp_string_putsn(out, tagname.ptr, tagname.len);
            rp_string_putc(out, '>');
        }
    }
    else if (strcmp(fname, "#language") == 0) {
        if (nargs > 0) {
            slice_t lang = expand_and_trim(ec, args[0], depth + 1, buf1);
            rp_string_putsn(out, lang.ptr, lang.len);
        }
    }
    else if (strcmp(fname, "formatnum") == 0) {
        slice_t num = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        if (num.len > 0) {
            /* Check for R flag */
            int raw = 0;
            if (nargs > 1) {
                slice_t flag = expand_and_trim(ec, args[1], depth + 1, buf2);
                if (flag.len == 1 && (flag.ptr[0] == 'R' || flag.ptr[0] == 'r')) raw = 1;
                if (slice_ieq(flag, "NOSEP", 5)) raw = 1;
            }
            if (raw) {
                rp_string_putsn(out, num.ptr, num.len);
            } else {
                format_num_str(num.ptr, num.len, out);
            }
        }
    }
    else if (strcmp(fname, "lc") == 0) {
        if (nargs > 0) {
            rp_string_clear(buf1);
            expand_slice(ec, args[0], depth + 1, buf1);
            for (size_t i = 0; i < buf1->len; i++)
                rp_string_putc(out, tolower((unsigned char)buf1->str[i]));
        }
    }
    else if (strcmp(fname, "uc") == 0) {
        if (nargs > 0) {
            rp_string_clear(buf1);
            expand_slice(ec, args[0], depth + 1, buf1);
            for (size_t i = 0; i < buf1->len; i++)
                rp_string_putc(out, toupper((unsigned char)buf1->str[i]));
        }
    }
    else if (strcmp(fname, "lcfirst") == 0) {
        if (nargs > 0) {
            rp_string_clear(buf1);
            expand_slice(ec, args[0], depth + 1, buf1);
            if (buf1->len > 0) {
                rp_string_putc(out, tolower((unsigned char)buf1->str[0]));
                if (buf1->len > 1) rp_string_putsn(out, buf1->str + 1, buf1->len - 1);
            }
        }
    }
    else if (strcmp(fname, "ucfirst") == 0) {
        if (nargs > 0) {
            rp_string_clear(buf1);
            expand_slice(ec, args[0], depth + 1, buf1);
            if (buf1->len > 0) {
                rp_string_putc(out, toupper((unsigned char)buf1->str[0]));
                if (buf1->len > 1) rp_string_putsn(out, buf1->str + 1, buf1->len - 1);
            }
        }
    }
    else if (strcmp(fname, "urlencode") == 0) {
        slice_t val = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        for (int i = 0; i < val.len; i++) {
            unsigned char c = (unsigned char)val.ptr[i];
            if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
                rp_string_putc(out, c);
            } else {
                rp_string_appendf(out, "%%%02X", c);
            }
        }
    }
    else if (strcmp(fname, "anchorencode") == 0) {
        slice_t val = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        for (int i = 0; i < val.len; i++) {
            unsigned char c = (unsigned char)val.ptr[i];
            if (c == ' ') rp_string_putc(out, '_');
            else rp_string_putc(out, c);
        }
    }
    else if (strcmp(fname, "padleft") == 0 || strcmp(fname, "padright") == 0) {
        slice_t val = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        int width = 0;
        if (nargs > 1) {
            slice_t ws = expand_and_trim(ec, args[1], depth + 1, buf2);
            char tmp[32]; int tl = ws.len < 31 ? ws.len : 31;
            memcpy(tmp, ws.ptr, tl); tmp[tl] = '\0';
            width = atoi(tmp);
        }
        char padchar = '0';
        if (nargs > 2) {
            rp_string_clear(buf2);
            expand_slice(ec, args[2], depth + 1, buf2);
            if (buf2->len > 0) padchar = buf2->str[0];
        }
        int padding = width - val.len;
        if (padding < 0) padding = 0;
        if (strcmp(fname, "padleft") == 0) {
            for (int i = 0; i < padding; i++) rp_string_putc(out, padchar);
            rp_string_putsn(out, val.ptr, val.len);
        } else {
            rp_string_putsn(out, val.ptr, val.len);
            for (int i = 0; i < padding; i++) rp_string_putc(out, padchar);
        }
    }
    else if (strcmp(fname, "ns") == 0 || strcmp(fname, "nse") == 0) {
        /* Return empty — we'd need namespace lookup table */
        if (nargs > 0) {
            slice_t nsnum = expand_and_trim(ec, args[0], depth + 1, buf1);
            rp_string_putsn(out, nsnum.ptr, nsnum.len);
        }
    }
    else if (strcmp(fname, "localurl") == 0 || strcmp(fname, "fullurl") == 0 ||
             strcmp(fname, "canonicalurl") == 0) {
        slice_t page = (nargs > 0) ? expand_and_trim(ec, args[0], depth + 1, buf1) : make_slice("", 0);
        rp_string_putsn(out, page.ptr, page.len);
    }
    else if (strcmp(fname, "#plural") == 0 || strcmp(fname, "#grammar") == 0 ||
             strcmp(fname, "#gender") == 0) {
        /* Return first non-empty arg */
        for (int i = 1; i < nargs; i++) {
            slice_t v = expand_and_trim(ec, args[i], depth + 1, buf1);
            if (v.len > 0) { rp_string_putsn(out, v.ptr, v.len); break; }
        }
    }
    else {
        handled = 0;
    }

    rp_string_free(buf1);
    rp_string_free(buf2);
    return handled;
}

/* ================================================================
   Core expansion: expand_single_template
   ================================================================ */

static void expand_single_template(expand_ctx *ec, const char *inner, int inner_len,
                                   int depth, rp_string *out) {
    if (depth >= ec->max_depth || limits_exceeded(ec)) return;
    ec->call_count++;

    /* Split inner on | to get parts */
    slice_t parts[MAX_PARTS];
    int nparts = split_parts(inner, inner_len, parts, MAX_PARTS);
    if (nparts == 0) return;

    /* Expand the template name */
    rp_string *name_buf = rp_string_new(256);
    wiki_expand(ec, parts[0].ptr, parts[0].len, depth + 1, name_buf);

    /* Trim the name */
    const char *np = name_buf->str;
    int nlen = (int)name_buf->len;
    while (nlen > 0 && (*np == ' ' || *np == '\t' || *np == '\n')) { np++; nlen--; }
    while (nlen > 0 && (np[nlen-1] == ' ' || np[nlen-1] == '\t' || np[nlen-1] == '\n')) nlen--;

    if (nlen == 0) { rp_string_free(name_buf); return; }

    /* Strip subst: and safesubst: prefixes */
    if (nlen > 6 && strncasecmp(np, "subst:", 6) == 0) { np += 6; nlen -= 6; }
    else if (nlen > 10 && strncasecmp(np, "safesubst:", 10) == 0) { np += 10; nlen -= 10; }
    while (nlen > 0 && *np == ' ') { np++; nlen--; }

    /* Capitalize first letter */
    char name_copy[4096];
    if (nlen >= (int)sizeof(name_copy)) nlen = (int)sizeof(name_copy) - 1;
    memcpy(name_copy, np, nlen);
    name_copy[nlen] = '\0';
    if (nlen > 0 && name_copy[0] >= 'a' && name_copy[0] <= 'z')
        name_copy[0] -= 32;

    /* Check magic words */
    int vlen;
    const char *mw = get_magic_word(ec, name_copy, nlen, &vlen);
    if (mw) {
        rp_string_putsn(out, mw, vlen);
        rp_string_free(name_buf);
        return;
    }

    /* Check for parser function (name contains :) */
    int colon = -1;
    for (int i = 0; i < nlen; i++) {
        if (name_copy[i] == ':') { colon = i; break; }
    }

    if (colon >= 0) {
        slice_t funcname = make_slice(name_copy, colon);
        /* Build args: first arg is text after colon, rest from parts[1:] */
        slice_t func_args[MAX_PARTS];
        int func_nargs = 0;
        func_args[func_nargs++] = make_slice(name_copy + colon + 1, nlen - colon - 1);
        for (int i = 1; i < nparts && func_nargs < MAX_PARTS; i++) {
            func_args[func_nargs++] = parts[i];
        }
        int handled = call_parser_function(ec, funcname, func_args, func_nargs, depth, out);
        if (handled) {
            rp_string_free(name_buf);
            return;
        }

        /* Check if the part before colon is a magic word */
        mw = get_magic_word(ec, name_copy, colon, &vlen);
        if (mw) {
            rp_string_putsn(out, mw, vlen);
            rp_string_free(name_buf);
            return;
        }
    }

    /* Check for DISPLAYTITLE, DEFAULTSORT */
    if (strncmp(name_copy, "DISPLAYTITLE:", 13) == 0 ||
        strncmp(name_copy, "DEFAULTSORT:", 12) == 0 ||
        strncmp(name_copy, "DEFAULTSORTKEY:", 15) == 0) {
        rp_string_free(name_buf);
        return;
    }

    /* Look up template via JS callback */
    int tpl_len;
    const char *tpl_text = lookup_template(ec, name_copy, nlen, &tpl_len);
    if (!tpl_text || tpl_len == 0) {
        /* For #invoke templates, Part 1 is the Lua function name (e.g.
           "unbulleted", "infobox", "navbox") — never useful text.  Skip it
           so it doesn't pollute output or prevent the outer template's
           fallback from triggering. */
        int is_invoke = (nlen > 8 && strncasecmp(name_copy, "#invoke:", 8) == 0);
        /* Template not found. Extract meaningful content from parameters
           rather than dropping everything. We already have `parts` split
           on |. For each parameter, extract the value (after = if named)
           and emit it if it looks like useful text. Join with single
           newlines so they don't become separate search paragraphs. */
        int emitted = 0;
        for (int pi = 1; pi < nparts; pi++) {
            /* For #invoke, Part 1 is the Lua function name — skip it */
            if (is_invoke && pi == 1) continue;
            slice_t p = slice_trim(parts[pi]);
            if (p.len == 0) continue;

            /* For named params (key=value), extract value */
            slice_t val = p;
            int eqpos = -1, d = 0;
            for (int k = 0; k < p.len; k++) {
                char c = p.ptr[k];
                if (c == '{' && k+1 < p.len && p.ptr[k+1] == '{') { d++; k++; }
                else if (c == '}' && k+1 < p.len && p.ptr[k+1] == '}') { d--; k++; }
                else if (c == '=' && d == 0) { eqpos = k; break; }
            }
            if (eqpos >= 0 && eqpos < 40) {
                val = slice_trim(make_slice(p.ptr + eqpos + 1, p.len - eqpos - 1));
            }
            if (val.len == 0) continue;

            /* Skip JSON-like values (GeoJSON from Maplink etc.) */
            if (val.len > 2 && (val.ptr[0] == '{' || val.ptr[0] == '[')) continue;

            /* Skip values that are just control tokens, filenames, codes, numbers */
            if (val.len < 2) continue;
            /* Skip common boolean/layout values */
            if (slice_ieq(val, "oui", 3) || slice_ieq(val, "non", 3) ||
                slice_ieq(val, "yes", 3) || slice_ieq(val, "no", 2) ||
                slice_ieq(val, "true", 4) || slice_ieq(val, "false", 5) ||
                slice_ieq(val, "left", 4) || slice_ieq(val, "right", 5) ||
                slice_ieq(val, "center", 6) || slice_ieq(val, "none", 4) ||
                slice_ieq(val, "auto", 4) ||
                slice_ieq(val, "noredlink", 9) || slice_ieq(val, "variant", 7) ||
                slice_ieq(val, "size", 4) || slice_ieq(val, "check", 5) ||
                slice_ieq(val, "nocat", 5) || slice_ieq(val, "hlist", 5) ||
                slice_ieq(val, "plainlist", 9) || slice_ieq(val, "sidebar", 7) ||
                slice_ieq(val, "navbox", 6) || slice_ieq(val, "transparent", 11) ||
                slice_ieq(val, "cellpadding", 11) || slice_ieq(val, "cellspacing", 11) ||
                slice_ieq(val, "border", 6) || slice_ieq(val, "nowrap", 6) ||
                slice_ieq(val, "colspan", 7) || slice_ieq(val, "rowspan", 7)) continue;
            /* Skip pure numbers and sizes */
            {
                int all_num = 1;
                for (int k = 0; k < val.len; k++) {
                    char c = val.ptr[k];
                    if (!isdigit((unsigned char)c) && c != '.' && c != '%' &&
                        c != 'p' && c != 'x' && c != 'e' && c != 'm') {
                        all_num = 0; break;
                    }
                }
                if (all_num) continue;
            }
            /* Skip color codes like #fff or #a1b2c3 */
            if (val.len <= 8 && val.ptr[0] == '#') continue;
            /* Skip single words that are likely parameter names or codes
               (e.g., "user", "nocat", "lang", "format", etc.) */
            if (val.len <= 20) {
                int is_single_word = 1;
                for (int k = 0; k < val.len; k++) {
                    char c = val.ptr[k];
                    if (!isalpha((unsigned char)c) && c != '_' && c != '-') {
                        is_single_word = 0; break;
                    }
                }
                if (is_single_word && val.len <= 3) continue; /* short codes */
                /* Skip common template parameter names */
                if (is_single_word && (
                    slice_ieq(val, "user", 4) ||
                    slice_ieq(val, "nocat", 5) ||
                    slice_ieq(val, "lang", 4) ||
                    slice_ieq(val, "format", 6) ||
                    slice_ieq(val, "style", 5) ||
                    slice_ieq(val, "class", 5) ||
                    slice_ieq(val, "width", 5) ||
                    slice_ieq(val, "height", 6) ||
                    slice_ieq(val, "align", 5) ||
                    slice_ieq(val, "border", 6) ||
                    slice_ieq(val, "thumb", 5) ||
                    slice_ieq(val, "vignette", 8) ||
                    slice_ieq(val, "redresse", 8) ||
                    slice_ieq(val, "gauche", 6) ||
                    slice_ieq(val, "droite", 6) ||
                    slice_ieq(val, "upright", 7) ||
                    slice_ieq(val, "frameless", 9) ||
                    slice_ieq(val, "baseline", 8) ||
                    slice_ieq(val, "verifierLesArguments", 20)
                )) continue;
            }
            /* Skip image filenames */
            if (val.len > 4) {
                const char *ext = val.ptr + val.len - 4;
                if (strncasecmp(ext, ".jpg", 4) == 0 || strncasecmp(ext, ".png", 4) == 0 ||
                    strncasecmp(ext, ".svg", 4) == 0 || strncasecmp(ext, ".gif", 4) == 0) continue;
                if (val.len > 5 && strncasecmp(val.ptr + val.len - 5, ".jpeg", 5) == 0) continue;
                if (val.len > 5 && strncasecmp(val.ptr + val.len - 5, ".webp", 5) == 0) continue;
            }
            /* Skip CSS properties: word-word:value, word-word;value,
               or word-word=value (wiki-style CSS like font-size=100%) */
            if (val.len < 40) {
                int has_css_sep = 0;
                for (int ck = 1; ck < val.len; ck++) {
                    if ((val.ptr[ck] == ':' || val.ptr[ck] == ';') && val.ptr[ck-1] != ' ') {
                        int cw = ck - 1;
                        while (cw >= 0 && ((val.ptr[cw] >= 'a' && val.ptr[cw] <= 'z') || val.ptr[cw] == '-'))
                            cw--;
                        if (ck - cw > 3) { has_css_sep = 1; break; }
                    }
                    /* = as CSS separator only when preceded by hyphenated word */
                    if (val.ptr[ck] == '=' && val.ptr[ck-1] != ' ') {
                        int cw = ck - 1, ch = 0;
                        while (cw >= 0 && ((val.ptr[cw] >= 'a' && val.ptr[cw] <= 'z') || val.ptr[cw] == '-')) {
                            if (val.ptr[cw] == '-') ch = 1;
                            cw--;
                        }
                        if (ck - cw > 3 && ch) { has_css_sep = 1; break; }
                    }
                }
                if (has_css_sep) continue;
            }
            /* Skip code-like values: all [a-z0-9.%-] with both a hyphen
               AND a digit (e.g. bar21-font-size-90%, border-width-0.5).
               Requiring digits avoids filtering real words like mid-century. */
            if (val.len >= 5 && val.len < 40) {
                int all_code = 1, has_hyph = 0, has_digit = 0;
                for (int k = 0; k < val.len; k++) {
                    char c = val.ptr[k];
                    if (c == '-') has_hyph = 1;
                    else if (c >= '0' && c <= '9') has_digit = 1;
                    else if (!((c >= 'a' && c <= 'z') ||
                              c == '.' || c == '%')) { all_code = 0; break; }
                }
                if (all_code && has_hyph && has_digit) continue;
            }
            /* Skip HTML attribute assignments: word="value" or word='value'
               (e.g. Rowspan="2", colspan="3", style="...") */
            if (val.len >= 4 && val.len < 40) {
                int eq = -1;
                for (int k = 0; k < val.len; k++) {
                    if (val.ptr[k] == '=') { eq = k; break; }
                }
                if (eq >= 2 && eq < val.len - 1 &&
                    (val.ptr[eq+1] == '"' || val.ptr[eq+1] == '\'')) {
                    int attr_ok = 1;
                    for (int k = 0; k < eq; k++) {
                        char c = val.ptr[k];
                        if (!isalpha((unsigned char)c) && c != '-') { attr_ok = 0; break; }
                    }
                    if (attr_ok) continue;
                }
            }

            /* Recursively expand the value (it may contain templates) */
            if (emitted > 0) rp_string_putc(out, '\n'); /* single newline */
            wiki_expand(ec, val.ptr, val.len, depth + 1, out);
            emitted++;
        }

        rp_string_free(name_buf);
        return;
    }

    /* Build parameter hash table */
    hashtable_t params;
    ht_init(&params);
    int positional = 0;

    for (int i = 1; i < nparts; i++) {
        /* Find first = not inside {{ }} */
        int eqpos = -1, d = 0;
        for (int k = 0; k < parts[i].len; k++) {
            char c = parts[i].ptr[k];
            if (c == '{' && k+1 < parts[i].len && parts[i].ptr[k+1] == '{') { d++; k++; }
            else if (c == '}' && k+1 < parts[i].len && parts[i].ptr[k+1] == '}') { d--; k++; }
            else if (c == '=' && d == 0) { eqpos = k; break; }
        }

        if (eqpos >= 0) {
            slice_t pname = slice_trim(make_slice(parts[i].ptr, eqpos));
            slice_t pval = make_slice(parts[i].ptr + eqpos + 1, parts[i].len - eqpos - 1);
            /* Don't trim value if it contains ]] */
            int has_bracket = 0;
            for (int k = 0; k < pval.len - 1; k++) {
                if (pval.ptr[k] == ']' && pval.ptr[k+1] == ']') { has_bracket = 1; break; }
            }
            if (!has_bracket) pval = slice_trim(pval);
            ht_set(&params, pname.ptr, pname.len, pval.ptr, pval.len);
        } else {
            positional++;
            char poskey[16];
            int pklen = snprintf(poskey, sizeof(poskey), "%d", positional);
            slice_t pval = parts[i];
            int has_bracket = 0;
            for (int k = 0; k < pval.len - 1; k++) {
                if (pval.ptr[k] == ']' && pval.ptr[k+1] == ']') { has_bracket = 1; break; }
            }
            if (!has_bracket) pval = slice_trim(pval);
            ht_set(&params, poskey, pklen, pval.ptr, pval.len);
        }
    }

    /* Expand template body with parameter resolution via tree-walking.
       wiki_expand_with_params preprocesses the body into a tree, then
       expands it — PP_TPLARG nodes look up values in &params. */
    size_t out_before = out->len;
    wiki_expand_with_params(ec, tpl_text, tpl_len, &params, depth + 1, out);

    /* If the template body produced nothing useful (typically because it's
       entirely #invoke-based and we don't have Lua), extract meaningful
       content from the parameters instead of returning empty. */
    {
        /* Check if output is empty or just whitespace/categories/sentinels */
        int has_content = 0;
        for (size_t k = out_before; k < out->len; k++) {
            char c = out->str[k];
            if (c != ' ' && c != '\n' && c != '\t' && c != '\r' &&
                c != '\x01' && c != '\x02') {
                has_content = 1;
                break;
            }
        }
        if (!has_content && nparts > 1) {
            out->len = out_before;
            int emitted = 0;
            for (int pi = 1; pi < nparts; pi++) {
                slice_t p = slice_trim(parts[pi]);
                if (p.len == 0) continue;
                slice_t val = p;
                int eqpos = -1, d = 0;
                for (int k = 0; k < p.len; k++) {
                    char c = p.ptr[k];
                    if (c == '{' && k+1 < p.len && p.ptr[k+1] == '{') { d++; k++; }
                    else if (c == '}' && k+1 < p.len && p.ptr[k+1] == '}') { d--; k++; }
                    else if (c == '=' && d == 0) { eqpos = k; break; }
                }
                if (eqpos >= 0 && eqpos < 40) {
                    val = slice_trim(make_slice(p.ptr + eqpos + 1, p.len - eqpos - 1));
                }
                if (val.len < 3) continue;
                /* Skip JSON-like values (GeoJSON from Maplink etc.) */
                if (val.len > 2 && (val.ptr[0] == '{' || val.ptr[0] == '[')) continue;
                /* Skip common control values and language codes */
                if (slice_ieq(val,"oui",3) || slice_ieq(val,"non",3) ||
                    slice_ieq(val,"yes",3) || slice_ieq(val,"no",2) ||
                    slice_ieq(val,"true",4) || slice_ieq(val,"false",5) ||
                    slice_ieq(val,"fr",2) || slice_ieq(val,"en",2) ||
                    slice_ieq(val,"de",2) || slice_ieq(val,"it",2) ||
                    slice_ieq(val,"es",2) ||
                    slice_ieq(val,"noredlink",9) || slice_ieq(val,"variant",7) ||
                    slice_ieq(val,"size",4) || slice_ieq(val,"check",5) ||
                    slice_ieq(val,"nocat",5) || slice_ieq(val,"center",6) ||
                    slice_ieq(val,"right",5) || slice_ieq(val,"left",4) ||
                    slice_ieq(val,"none",4) || slice_ieq(val,"auto",4) ||
                    slice_ieq(val,"hlist",5) || slice_ieq(val,"plainlist",9) ||
                    slice_ieq(val,"sidebar",7) || slice_ieq(val,"navbox",6) ||
                    slice_ieq(val,"transparent",11) ||
                    slice_ieq(val,"cellpadding",11) || slice_ieq(val,"cellspacing",11) ||
                    slice_ieq(val,"border",6) || slice_ieq(val,"nowrap",6) ||
                    slice_ieq(val,"colspan",7) || slice_ieq(val,"rowspan",7)) continue;
                /* Skip single short alpha-only words (param codes) */
                if (val.len <= 3) {
                    int sw = 1;
                    for (int k = 0; k < val.len; k++)
                        if (!isalpha((unsigned char)val.ptr[k])) { sw = 0; break; }
                    if (sw) continue;
                }
                /* Skip pure numbers/sizes */
                { int all_num = 1;
                  for (int k = 0; k < val.len; k++) {
                      char c = val.ptr[k];
                      if (!isdigit((unsigned char)c) && c != '.' && c != '%' &&
                          c != 'p' && c != 'x') { all_num = 0; break; }
                  }
                  if (all_num) continue; }
                /* Skip ISBNs, color codes, filenames */
                if (val.len <= 8 && val.ptr[0] == '#') continue;
                /* Skip ISBN-like numbers: digits and dashes */
                if (val.len >= 10 && val.len <= 20) {
                    int all_isbn = 1;
                    for (int k = 0; k < val.len; k++) {
                        char c = val.ptr[k];
                        if (!isdigit((unsigned char)c) && c != '-' && c != 'X' && c != 'x')
                            { all_isbn = 0; break; }
                    }
                    if (all_isbn) continue;
                }
                if (val.len > 4) {
                    const char *ext = val.ptr + val.len - 4;
                    if (strncasecmp(ext,".jpg",4)==0 || strncasecmp(ext,".png",4)==0 ||
                        strncasecmp(ext,".svg",4)==0) continue;
                }
                /* Skip URLs */
                if (val.len > 7 && (strncasecmp(val.ptr,"http://",7)==0 ||
                    strncasecmp(val.ptr,"https://",8)==0)) continue;
                /* Skip category/namespace references */
                if ((val.len > 9 && strncasecmp(val.ptr, "category:", 9) == 0) ||
                    (val.len > 11 && strncasecmp(val.ptr, "catégorie:", 11) == 0) ||
                    (val.len > 5 && strncasecmp(val.ptr, "file:", 5) == 0) ||
                    (val.len > 8 && strncasecmp(val.ptr, "fichier:", 8) == 0) ||
                    (val.len > 6 && strncasecmp(val.ptr, "image:", 6) == 0)) continue;
                /* Skip SPARQL queries and code-like values */
                if (val.len > 20 && (memmem(val.ptr, val.len, "?stroke", 7) ||
                    memmem(val.ptr, val.len, "SELECT ", 7) ||
                    memmem(val.ptr, val.len, "WHERE{", 6) ||
                    memmem(val.ptr, val.len, "WHERE {", 7) ||
                    memmem(val.ptr, val.len, "wd:", 3) ||
                    memmem(val.ptr, val.len, "wdt:", 4) ||
                    memmem(val.ptr, val.len, "geoshape", 8) ||
                    memmem(val.ptr, val.len, "ExternalData", 12))) continue;
                /* Skip CSS property values — word-word:value, word-word;value,
                   or word-word=value (wiki-style CSS like font-size=100%) */
                if (val.len < 60) {
                    int _css = 0;
                    for (int ck = 1; ck < val.len; ck++) {
                        if ((val.ptr[ck] == ':' || val.ptr[ck] == ';') && val.ptr[ck-1] != ' ') {
                            int cw = ck - 1;
                            while (cw >= 0 && ((val.ptr[cw] >= 'a' && val.ptr[cw] <= 'z') || val.ptr[cw] == '-'))
                                cw--;
                            if (ck - cw > 3) { _css = 1; break; }
                        }
                        if (val.ptr[ck] == '=' && val.ptr[ck-1] != ' ') {
                            int cw = ck - 1, ch = 0;
                            while (cw >= 0 && ((val.ptr[cw] >= 'a' && val.ptr[cw] <= 'z') || val.ptr[cw] == '-')) {
                                if (val.ptr[cw] == '-') ch = 1;
                                cw--;
                            }
                            if (ck - cw > 3 && ch) { _css = 1; break; }
                        }
                    }
                    if (_css) continue;
                }
                /* Skip standalone CSS property names (text-align, font-size, etc.) */
                if (val.len <= 25 && val.len >= 5) {
                    int _cp = 1, _ch = 0;
                    for (int k = 0; k < val.len; k++) {
                        char c = val.ptr[k];
                        if (c == '-') _ch = 1;
                        else if (!(c >= 'a' && c <= 'z')) { _cp = 0; break; }
                    }
                    if (_cp && _ch) continue;
                }
                /* Skip code-like values: all [a-z0-9.%-] with both a hyphen
                   AND a digit (e.g. bar21-font-size-90%). Requiring digits
                   avoids filtering real words like mid-century. */
                if (val.len >= 5 && val.len < 40) {
                    int _ac = 1, _ch = 0, _cd = 0;
                    for (int k = 0; k < val.len; k++) {
                        char c = val.ptr[k];
                        if (c == '-') _ch = 1;
                        else if (c >= '0' && c <= '9') _cd = 1;
                        else if (!((c >= 'a' && c <= 'z') ||
                                  c == '.' || c == '%')) { _ac = 0; break; }
                    }
                    if (_ac && _ch && _cd) continue;
                }
                /* Skip HTML attribute assignments: word="value" or word='value' */
                if (val.len >= 4 && val.len < 40) {
                    int _eq = -1;
                    for (int k = 0; k < val.len; k++) {
                        if (val.ptr[k] == '=') { _eq = k; break; }
                    }
                    if (_eq >= 2 && _eq < val.len - 1 &&
                        (val.ptr[_eq+1] == '"' || val.ptr[_eq+1] == '\'')) {
                        int _ao = 1;
                        for (int k = 0; k < _eq; k++) {
                            char c = val.ptr[k];
                            if (!isalpha((unsigned char)c) && c != '-') { _ao = 0; break; }
                        }
                        if (_ao) continue;
                    }
                }
                if (emitted > 0) rp_string_putc(out, ' ');
                wiki_expand(ec, val.ptr, val.len, depth + 1, out);
                emitted++;
            }
        }
    }

    ht_free(&params);
    rp_string_free(name_buf);
}

/* ================================================================
   Pass 1.5: Flatten sentinels and build origin map
   ================================================================ */

static void flatten_sentinels(const char *text, int len,
                               rp_string *out, origin_map *origins) {
    int tpl_depth = 0;
    for (int i = 0; i < len; i++) {
        if (text[i] == '\x01') {
            tpl_depth++;
            /* Keep outermost sentinel in output */
            if (tpl_depth == 1) rp_string_putc(out, '\x01');
            continue;
        }
        if (text[i] == '\x02') {
            if (tpl_depth > 0) {
                tpl_depth--;
                /* Keep outermost sentinel in output */
                if (tpl_depth == 0) rp_string_putc(out, '\x02');
            }
            continue;
        }
        int pos = (int)out->len;
        rp_string_putc(out, text[i]);
        if (tpl_depth > 0)
            origin_map_set(origins, pos);
    }
}

/* ================================================================
   Helper functions for cleanup and markup stripping
   ================================================================ */

/* Check if p starts with str (case-insensitive, len chars) */
static inline int starts_ci(const char *p, int avail, const char *str, int slen) {
    if (avail < slen) return 0;
    for (int i = 0; i < slen; i++) {
        if (tolower((unsigned char)p[i]) != tolower((unsigned char)str[i])) return 0;
    }
    return 1;
}

/* Check if position q is at the start of a line, skipping sentinel bytes.
   In expanded text, \x01/\x02 sentinels can appear between \n and {| or |},
   so "at line start" means preceded by \n (possibly with sentinels between). */
static inline int at_line_start(const char *q, const char *base) {
    if (q <= base) return 1; /* start of text */
    const char *b = q - 1;
    while (b >= base && (*b == '\x01' || *b == '\x02')) b--;
    return (b < base || *b == '\n');
}

/* Skip past a closing tag like </ref>, </gallery>, etc.
   Returns pointer past the closing >, or NULL if not found. */
static const char *find_close_tag(const char *p, const char *end, const char *tag, int taglen) {
    while (p < end - taglen - 2) {
        if (p[0] == '<' && p[1] == '/') {
            if (starts_ci(p + 2, end - p - 2, tag, taglen)) {
                const char *gt = memchr(p, '>', end - p);
                if (gt) return gt + 1;
            }
        }
        p++;
    }
    return NULL;
}

/* ================================================================
   Pass 2: Strip wiki markup on FLAT text (no sentinels).

   Consumes remaining {{..}}, {{{..|..}}}, resolves [[..]] links,
   skips stray }, ]], etc.  Leaves {| and |} untouched for Pass 3.

   Propagates origin_map: each emitted byte inherits the template-origin
   status of its source position in the flat text (base_offset + input pos).
   ================================================================ */

static void strip_wiki_markup(const char *text, int len, rp_string *out,
                               const origin_map *in_origins, origin_map *out_origins,
                               int base_offset, int depth) {
    if (depth > 10 || len <= 0) {
        /* Depth limit or empty — copy through, preserving origin bits */
        for (int i = 0; i < len; i++) {
            int opos = (int)out->len;
            rp_string_putc(out, text[i]);
            if (in_origins && origin_map_get((origin_map *)in_origins, base_offset + i))
                origin_map_set(out_origins, opos);
        }
        return;
    }
    const char *p = text;
    const char *end = text + len;

    while (p < end) {
        int ipos = (int)(p - text); /* position in this call's text */

        /* ---- Sentinels: pass through transparently ---- */
        if (*p == '\x01' || *p == '\x02') {
            int opos = (int)out->len;
            rp_string_putc(out, *p);
            if (in_origins && origin_map_get((origin_map *)in_origins, base_offset + ipos))
                origin_map_set(out_origins, opos);
            p++;
            continue;
        }

        /* ---- {{{param|default}}} ---- */
        if (p + 2 < end && p[0] == '{' && p[1] == '{' && p[2] == '{') {
            const char *q = p + 3;
            int d = 1;
            while (q + 2 < end && d > 0) {
                if (q[0] == '{' && q[1] == '{' && q[2] == '{') { d++; q += 3; }
                else if (q[0] == '}' && q[1] == '}' && q[2] == '}') { d--; if (d > 0) q += 3; }
                else q++;
            }
            if (d == 0) {
                const char *inner = p + 3;
                int ilen = (int)(q - inner);
                int pipe = -1;
                for (int k = 0; k < ilen; k++) {
                    if (inner[k] == '|') { pipe = k; break; }
                }
                if (pipe >= 0) {
                    int sub_off = base_offset + (int)(inner + pipe + 1 - text);
                    strip_wiki_markup(inner + pipe + 1, ilen - pipe - 1, out,
                                      in_origins, out_origins, sub_off, depth + 1);
                }
                p = q + 3;
                continue;
            }
            p += 3;
            continue;
        }

        /* ---- {{template}} — extract useful content, drop braces ---- */
        if (p + 1 < end && p[0] == '{' && p[1] == '{') {
            const char *q = p + 2;
            int d = 1;
            int td = 0; /* tplarg depth */
            while (q + 1 < end && d > 0) {
                if (q + 2 < end && q[0] == '{' && q[1] == '{' && q[2] == '{') {
                    int bb = 0; const char *bk = q;
                    while (bk < end && *bk == '{') { bb++; bk++; }
                    if (bb == 3) { td++; q = bk; continue; }
                    /* 4+ opening: first 2 are {{ */
                    d++; q += 2;
                } else if (q[0] == '{' && q[1] == '{') {
                    d++; q += 2;
                } else if (q + 2 < end && q[0] == '}' && q[1] == '}' && q[2] == '}') {
                    int bb = 0; const char *bk = q;
                    while (bk < end && *bk == '}') { bb++; bk++; }
                    if (bb == 3 && td > 0) { td--; q = bk; continue; }
                    if (bb >= 5 && td > 0) { td--; q += 3; continue; }
                    /* fall through to }} handling */
                    d--; if (d > 0) q += 2;
                } else if (q[0] == '}' && q[1] == '}') {
                    d--; if (d > 0) q += 2;
                } else {
                    q++;
                }
            }
            if (d == 0) {
                const char *inner = p + 2;
                int ilen = (int)(q - inner);

                /* Split on first | to get name and params */
                int first_pipe = -1;
                int dd = 0;
                for (int k = 0; k < ilen; k++) {
                    if (inner[k] == '{' && k+1 < ilen && inner[k+1] == '{') { dd++; k++; }
                    else if (inner[k] == '}' && k+1 < ilen && inner[k+1] == '}') { dd--; k++; }
                    else if (inner[k] == '|' && dd == 0) { first_pipe = k; break; }
                }

                /* Skip parser functions (#if, #invoke, etc.) */
                slice_t name_s = slice_trim(make_slice(inner, first_pipe >= 0 ? first_pipe : ilen));
                if (name_s.len > 0 && name_s.ptr[0] == '#') {
                    p = q + 2;
                    continue;
                }

                /* Extract parameter values */
                if (first_pipe >= 0) {
                    const char *params = inner + first_pipe + 1;
                    int plen = ilen - first_pipe - 1;
                    slice_t parts[MAX_PARTS];
                    int nparts = split_parts(params, plen, parts, MAX_PARTS);
                    int emitted = 0;

                    for (int pi = 0; pi < nparts; pi++) {
                        slice_t pv = slice_trim(parts[pi]);
                        if (pv.len == 0) continue;

                        /* For named params, extract value after = */
                        slice_t val = pv;
                        int eq = -1, ed = 0;
                        for (int k = 0; k < pv.len; k++) {
                            if (pv.ptr[k] == '{' && k+1 < pv.len && pv.ptr[k+1] == '{') { ed++; k++; }
                            else if (pv.ptr[k] == '}' && k+1 < pv.len && pv.ptr[k+1] == '}') { ed--; k++; }
                            else if (pv.ptr[k] == '=' && ed == 0) { eq = k; break; }
                        }
                        if (eq >= 0 && eq < 40) {
                            val = slice_trim(make_slice(pv.ptr + eq + 1, pv.len - eq - 1));
                        }
                        if (val.len < 2) continue;
                        /* Skip control values */
                        if (slice_ieq(val,"oui",3) || slice_ieq(val,"non",3) ||
                            slice_ieq(val,"yes",3) || slice_ieq(val,"no",2) ||
                            slice_ieq(val,"true",4) || slice_ieq(val,"false",5) ||
                            slice_ieq(val,"left",4) || slice_ieq(val,"right",5) ||
                            slice_ieq(val,"center",6) || slice_ieq(val,"none",4) ||
                            slice_ieq(val,"auto",4)) continue;
                        /* Skip numbers, colors, filenames, short codes */
                        {
                            int all_num = 1;
                            for (int k = 0; k < val.len; k++) {
                                char c = val.ptr[k];
                                if (!isdigit((unsigned char)c) && c != '.' && c != '%' &&
                                    c != 'p' && c != 'x' && c != 'e' && c != 'm') {
                                    all_num = 0; break;
                                }
                            }
                            if (all_num) continue;
                        }
                        if (val.len <= 8 && val.ptr[0] == '#') continue;
                        if (val.len <= 20) {
                            int is_word = 1;
                            for (int k = 0; k < val.len; k++) {
                                char c = val.ptr[k];
                                if (!isalpha((unsigned char)c) && c != '_' && c != '-') {
                                    is_word = 0; break;
                                }
                            }
                            if (is_word && val.len <= 3) continue;
                            if (is_word && (
                                slice_ieq(val,"user",4) || slice_ieq(val,"nocat",5) ||
                                slice_ieq(val,"lang",4) || slice_ieq(val,"format",6) ||
                                slice_ieq(val,"style",5) || slice_ieq(val,"class",5) ||
                                slice_ieq(val,"width",5) || slice_ieq(val,"border",6) ||
                                slice_ieq(val,"thumb",5) || slice_ieq(val,"vignette",8) ||
                                slice_ieq(val,"redresse",8) || slice_ieq(val,"gauche",6) ||
                                slice_ieq(val,"droite",6) || slice_ieq(val,"upright",7) ||
                                slice_ieq(val,"frameless",9) || slice_ieq(val,"baseline",8)
                            )) continue;
                        }
                        if (val.len > 4) {
                            const char *ext = val.ptr + val.len - 4;
                            if (strncasecmp(ext,".jpg",4)==0 || strncasecmp(ext,".png",4)==0 ||
                                strncasecmp(ext,".svg",4)==0 || strncasecmp(ext,".gif",4)==0) continue;
                            if (val.len > 5 && strncasecmp(val.ptr+val.len-5,".jpeg",5)==0) continue;
                        }
                        if (val.len >= 3 && val.ptr[0] == '"' && val.ptr[val.len-1] == '"') continue;
                        {
                            int has_eq = 0, has_quote = 0;
                            for (int k = 0; k < val.len && k < 30; k++) {
                                if (val.ptr[k] == '=') has_eq = 1;
                                if (val.ptr[k] == '"') has_quote = 1;
                            }
                            if (has_eq && has_quote && val.len < 60) continue;
                        }
                        if (val.len < 30 && memmem(val.ptr, val.len, ":#", 2)) continue;
                        /* Skip CSS properties: word-word:value (e.g. text-align:left, width:100px) */
                        if (val.len < 40) {
                            int has_css_colon = 0;
                            for (int ck = 1; ck < val.len; ck++) {
                                if (val.ptr[ck] == ':' && val.ptr[ck-1] != ' ') {
                                    /* Check if chars before : are a CSS name (lowercase alpha or hyphen) */
                                    int cw = ck - 1;
                                    while (cw >= 0 && ((val.ptr[cw] >= 'a' && val.ptr[cw] <= 'z') || val.ptr[cw] == '-'))
                                        cw--;
                                    if (ck - cw > 3) { has_css_colon = 1; break; }
                                }
                            }
                            if (has_css_colon) continue;
                        }
                        if (memmem(val.ptr, val.len, "bgcolor", 7) ||
                            memmem(val.ptr, val.len, "colspan", 7) ||
                            memmem(val.ptr, val.len, "rowspan", 7) ||
                            memmem(val.ptr, val.len, "nvo,ke", 6)) continue;

                        if (emitted > 0) {
                            int opos = (int)out->len;
                            rp_string_putc(out, '\n');
                            /* newline inherits origin from the template boundary */
                            if (in_origins && origin_map_get((origin_map *)in_origins, base_offset + (int)(val.ptr - text)))
                                origin_map_set(out_origins, opos);
                        }
                        int sub_off = base_offset + (int)(val.ptr - text);
                        strip_wiki_markup(val.ptr, val.len, out,
                                           in_origins, out_origins, sub_off, depth + 1);
                        emitted++;
                    }
                }
                p = q + 2;
                continue;
            }
            /* Unmatched {{: if it starts with #tag: (opaque tag content
               with unmatched {{ inside), skip to end of scan.
               Otherwise just skip the {{ and let content flow through. */
            if (p + 6 < end && memcmp(p + 2, "#tag:", 5) == 0) {
                p = q; /* skip entire opaque tag content */
            } else {
                p += 2;
            }
            continue;
        }

        /* ---- Stray } — skip, but preserve |} at line start for table handling in Pass 3 ---- */
        if (p[0] == '}') {
            /* Check if this completes |} at line start (skip sentinels in output) */
            if (out->len > 0 && out->str[out->len - 1] == '|') {
                int bp = (int)out->len - 2;
                while (bp >= 0 && (out->str[bp] == '\x01' || out->str[bp] == '\x02')) bp--;
                if (bp < 0 || out->str[bp] == '\n') {
                    int opos = (int)out->len;
                    rp_string_putc(out, '}');
                    if (in_origins && origin_map_get((origin_map *)in_origins, base_offset + ipos))
                        origin_map_set(out_origins, opos);
                    p++; continue;
                }
            }
            p++; continue;
        }

        /* ---- [[link]] resolution ---- */
        if (p[0] == '[') {
            /* Skip sentinels between [ and [ to detect [[\x01[ etc. */
            const char *p2 = p + 1;
            while (p2 < end && (*p2 == '\x01' || *p2 == '\x02')) p2++;
            if (p2 < end && *p2 == '[') {
            int d = 1;
            const char *q = p2 + 1;
            while (q + 1 < end && d > 0) {
                if (q[0] == '[' && q[1] == '[') { d++; q += 2; }
                else if (q[0] == ']' && q[1] == ']') { d--; if (d > 0) q += 2; }
                else q++;
            }
            if (d == 0) {
                const char *inner = p2 + 1;
                int ilen = (int)(q - inner);

                /* Category/File/Image — strip */
                if (starts_ci(inner, ilen, "cat", 3) ||
                    starts_ci(inner, ilen, "file:", 5) ||
                    starts_ci(inner, ilen, "image:", 6) ||
                    starts_ci(inner, ilen, "fichier:", 8) ||
                    starts_ci(inner, ilen, "imagen:", 7) ||
                    starts_ci(inner, ilen, "datei:", 6) ||
                    starts_ci(inner, ilen, "archivo:", 8) ||
                    starts_ci(inner, ilen, "media:", 6)) {
                    p = q + 2;
                    continue;
                }

                /* Interwiki/language links [[xx:Page]] — strip.
                   These are 2-3 lowercase letters followed by : */
                if (ilen >= 3 && inner[0] >= 'a' && inner[0] <= 'z') {
                    int colon = -1;
                    for (int k = 1; k < ilen && k <= 3; k++) {
                        if (inner[k] == ':') { colon = k; break; }
                        if (!(inner[k] >= 'a' && inner[k] <= 'z')) break;
                    }
                    if (colon >= 2 && colon <= 3) {
                        p = q + 2;
                        continue;
                    }
                }

                /* Find last | at depth 0 for piped links */
                int lpipe = -1, dd = 0;
                for (int k = 0; k < ilen; k++) {
                    if (inner[k] == '[' && k+1 < ilen && inner[k+1] == '[') { dd++; k++; }
                    else if (inner[k] == ']' && k+1 < ilen && inner[k+1] == ']') { dd--; k++; }
                    else if (inner[k] == '|' && dd == 0) lpipe = k;
                }

                const char *label = lpipe >= 0 ? inner + lpipe + 1 : inner;
                int llen = lpipe >= 0 ? ilen - lpipe - 1 : ilen;
                int sub_off = base_offset + (int)(label - text);
                strip_wiki_markup(label, llen, out,
                                   in_origins, out_origins, sub_off, depth + 1);
                p = q + 2;
                continue;
            }
            p = p2 + 1; /* unmatched [[ — skip past second [ */
            continue;
            } /* end if p2 == '[' */
        }

        /* ---- Stray ]] — skip ---- */
        if (p + 1 < end && p[0] == ']' && p[1] == ']') { p += 2; continue; }

        /* ---- [textmodifier] edit links — skip ---- */
        if (p[0] == '[' && p + 1 < end && p[1] != '[') {
            const char *cb = memchr(p + 1, ']', end - p - 1);
            if (cb && (cb - p) < 200 && (cb - p) > 8) {
                if (starts_ci(cb - 8, 8, "modifier", 8) ||
                    starts_ci(cb - 7, 7, "modifie", 7)) {
                    p = cb + 1;
                    continue;
                }
            }
        }

        /* ---- Regular character (including {|, |} which pass through) ---- */
        {
            int opos = (int)out->len;
            rp_string_putc(out, *p);
            if (in_origins && origin_map_get((origin_map *)in_origins, base_offset + ipos))
                origin_map_set(out_origins, opos);
        }
        p++;
    }
}

/* ================================================================
   Initialize context from Duktape arguments
   ================================================================ */

/* ================================================================
   Pass 2.5: Filter debris — template-originated lines only.
   Uses origin_map instead of inline sentinels.
   ================================================================ */

static void filter_debris(const char *text, int len, rp_string *out,
                           const origin_map *origins) {
    int i = 0;
    int nl_count = 0;

    while (i < len) {
        /* Pass sentinel bytes through directly */
        if (text[i] == '\x01' || text[i] == '\x02') {
            rp_string_putc(out, text[i]);
            i++;
            continue;
        }

        /* Find line boundaries */
        int line_start = i;
        while (i < len && text[i] != '\n' && text[i] != '\x01' && text[i] != '\x02') i++;
        int line_end = i;
        if (i < len && text[i] == '\n') i++; /* skip \n */

        /* Trim for checks */
        int ts = line_start, te = line_end;
        while (ts < te && text[ts] == ' ') ts++;
        while (te > ts && text[te-1] == ' ') te--;
        int tlen = te - ts;

        /* Blank line */
        if (tlen == 0) {
            nl_count++;
            if (nl_count <= 2) rp_string_putc(out, '\n');
            continue;
        }

        /* Check if line has template-originated content */
        int has_tpl = origin_map_any_in_range((origin_map *)origins, ts, tlen);
        int discard = 0;

        /* Global check: standalone word=value lines where the entire line
           is just an HTML/template attribute.  These are never article text
           regardless of origin (e.g. "variant=2", "size=35"). */
        if (!discard && tlen > 2 && tlen < 30) {
            int eq = -1;
            for (int k = 0; k < tlen; k++) {
                if (text[ts+k] == '=') { eq = k; break; }
                if (text[ts+k] == ' ') break;
            }
            if (eq >= 2 && eq < tlen) {
                int valid = 1;
                for (int k = 0; k < eq; k++) {
                    if (!((text[ts+k] >= 'a' && text[ts+k] <= 'z') || text[ts+k] == '-'))
                        { valid = 0; break; }
                }
                if (valid) discard = 1;
            }
        }

        if (has_tpl) {
            const char *dp = text + ts;
            int dlen = tlen;

            /* Skip leading list markers */
            if (dlen > 2 && (*dp == '-' || *dp == '*') && dp[1] == ' ') {
                dp += 2; dlen -= 2;
                while (dlen > 0 && *dp == ' ') { dp++; dlen--; }
            }

            /* Lines ending with = */
            if (dlen > 2 && dlen < 80 && dp[dlen-1] == '=') discard = 1;

            /* Quoted values */
            if (!discard && dlen >= 3 && dlen < 60 &&
                dp[0] == '"' && dp[dlen-1] == '"') discard = 1;

            /* HTML attribute: word="value" or word=value */
            if (!discard && dlen > 3 && dlen < 80) {
                int eq = -1;
                for (int k = 0; k < dlen; k++) {
                    if (dp[k] == '=') { eq = k; break; }
                    if (dp[k] == ' ') break;
                }
                if (eq > 0 && eq < dlen - 1) {
                    int valid_attr = 1;
                    for (int k = 0; k < eq; k++) {
                        if (!((dp[k] >= 'a' && dp[k] <= 'z') || dp[k] == '-'))
                            { valid_attr = 0; break; }
                    }
                    if (valid_attr && eq >= 2) discard = 1;
                }
            }

            /* bgcolor/colspan/rowspan */
            if (!discard && memmem(dp, dlen, "bgcolor", 7)) discard = 1;
            if (!discard && memmem(dp, dlen, "colspan", 7)) discard = 1;
            if (!discard && memmem(dp, dlen, "rowspan", 7)) discard = 1;

            /* CSS: color:#hex */
            if (!discard && dlen < 40 && memmem(dp, dlen, ":#", 2)) discard = 1;

            /* invoke: debris */
            if (!discard && memmem(dp, dlen, "nvo,ke", 6)) discard = 1;

            /* Very short non-alpha lines (but preserve {| and |} for table handling) */
            if (!discard && dlen < 5) {
                int is_table_marker = (dlen >= 2 &&
                    ((dp[0] == '{' && dp[1] == '|') || (dp[0] == '|' && dp[1] == '}')));
                if (!is_table_marker) {
                    int has_alpha = 0;
                    for (int k = 0; k < dlen; k++)
                        if (isalpha((unsigned char)dp[k]) || (unsigned char)dp[k] >= 0xC0)
                            { has_alpha = 1; break; }
                    if (!has_alpha) discard = 1;
                }
            }
        }

        if (discard) continue;

        /* Emit line */
        nl_count = 0;
        /* Strip leading stray " from template debris */
        if (has_tpl && tlen > 2 && text[ts] == '"' && text[ts+1] == ' ') {
            rp_string_putsn(out, text + ts + 2, line_end - ts - 2);
        } else {
            rp_string_putsn(out, text + line_start, (i > line_end ? line_end + 1 : line_end) - line_start);
        }
    }

    /* Trim trailing whitespace */
    while (out->len > 0 && (out->str[out->len-1] == '\n' || out->str[out->len-1] == ' '))
        out->len--;
    out->str[out->len] = '\0';
}

/* ================================================================
   Initialize context from Duktape arguments
   ================================================================ */

static void load_magic_words(expand_ctx *ec, duk_context *ctx, duk_idx_t obj_idx) {
    ht_init(&ec->magic);
    duk_enum(ctx, obj_idx, 0);
    while (duk_next(ctx, -1, 1)) {
        duk_size_t klen, vlen;
        const char *key = duk_get_lstring(ctx, -2, &klen);
        const char *val = duk_get_lstring(ctx, -1, &vlen);
        if (key && val) {
            ht_set(&ec->magic, key, (int)klen, val, (int)vlen);
        }
        duk_pop_2(ctx);
    }
    duk_pop(ctx); /* enum */
}

/* ================================================================
   Post-expansion cleanup — all in C for performance.

   Performs: comment stripping, ref stripping, tag stripping,
   template/tplarg/table stripping, link resolution, bold/italic,
   section headers, HTML tags, whitespace normalization, debris cleanup.

   Operates on the expanded text and returns cleaned text.
   ================================================================ */

/* starts_ci and find_close_tag are defined earlier (before finalize_text) */

/*
   Inline helper: emit a character to output with whitespace/line tracking.
   Handles: space collapsing, leading/trailing space trimming per line,
   paragraph break normalization, pipe replacement, debris line detection.
*/

#define EMIT_CHAR(out, c, last, consec_nl, line_alpha, line_start_pos) do { \
    char _c = (c); \
    if (_c == '\n') { \
        /* Trim trailing spaces before this newline */ \
        while ((out)->len > 0 && (size_t)(line_start_pos) < (out)->len && (out)->str[(out)->len - 1] == ' ') \
            (out)->len--; \
        /* Discard lines that are just "key =" (infobox param debris). \
           If discarded, don't emit the newline either. */ \
        { \
            int _line_len = (line_start_pos >= 0 && (size_t)(line_start_pos) <= (out)->len) \
                ? (int)((out)->len - (line_start_pos)) : 0; \
            /* Only discard truly empty/non-alpha very short lines. \
               All content-level filtering belongs in finalize_text, \
               not here in the general cleanup. */ \
            int _discard = 0; \
            if (!(line_alpha) && _line_len > 0 && _line_len < 5) \
                _discard = 1; \
            if (_discard) { \
                (out)->len = (size_t)(line_start_pos); \
                /* Don't emit newline — skip it entirely */ \
            } else { \
                (consec_nl)++; \
                if ((consec_nl) <= 2) { \
                    rp_string_putc((out), '\n'); \
                } \
            } \
        } \
        (last) = '\n'; \
        (line_alpha) = 0; \
        (line_start_pos) = (int)(out)->len; \
    } else if (_c == ' ' || _c == '\t' || _c == '\r' || _c == '\f' || _c == '\v') { \
        /* Skip leading spaces and collapse multiple spaces. \
           Don't reset consec_nl — spaces between newlines shouldn't \
           prevent newline collapsing. */ \
        if ((last) != '\n' && (last) != ' ' && (last) != 0) { \
            rp_string_putc((out), ' '); \
            (last) = ' '; \
        } \
    } else if (_c == '|') { \
        /* Replace stray pipes with space (same collapse rules) */ \
        if ((last) != '\n' && (last) != ' ' && (last) != 0) { \
            rp_string_putc((out), ' '); \
            (last) = ' '; \
        } \
    } else { \
        if (isalpha((unsigned char)_c) || (unsigned char)_c >= 0xC0) (line_alpha) = 1; \
        rp_string_putc((out), _c); \
        (last) = _c; \
        (consec_nl) = 0; \
    } \
} while(0)

static void cleanup_expanded_text(const char *text, int len, rp_string *out,
                                  const origin_map *origins) {
    /* Pre-pass: strip transclusion tags that may be in expanded template source.
       <includeonly> and </includeonly> — strip tags, keep content.
       <noinclude>...</noinclude> — strip tags and content.
       <templatestyles.../> — strip entirely.
       <nowiki /> — strip. */
    rp_string *pre = rp_string_new(len + 64);
    {
        const char *s = text;
        const char *se = text + len;
        while (s < se) {
            if (s[0] == '<') {
                /* <includeonly> or </includeonly> — strip tag, keep content */
                if (starts_ci(s+1, se-s-1, "includeonly", 11) ||
                    starts_ci(s+1, se-s-1, "/includeonly", 12)) {
                    while (s < se && *s != '>') s++;
                    if (s < se) s++;
                    continue;
                }
                /* <noinclude>...</noinclude> — strip everything */
                if (starts_ci(s+1, se-s-1, "noinclude", 9)) {
                    char nx = s[10];
                    if (nx == '>' || nx == ' ' || nx == '/') {
                        const char *cl = find_close_tag(s, se, "noinclude", 9);
                        if (cl) { s = cl; continue; }
                        /* Self-closing or unclosed — skip to > */
                        while (s < se && *s != '>') s++;
                        if (s < se) s++;
                        continue;
                    }
                }
                /* </noinclude> stray closer */
                if (starts_ci(s+1, se-s-1, "/noinclude", 10)) {
                    while (s < se && *s != '>') s++;
                    if (s < se) s++;
                    continue;
                }
                /* <templatestyles.../> — strip */
                if (starts_ci(s+1, se-s-1, "templatestyles", 14)) {
                    while (s < se && *s != '>') s++;
                    if (s < se) s++;
                    continue;
                }
                /* <nowiki /> — strip */
                if (starts_ci(s+1, se-s-1, "nowiki", 6)) {
                    while (s < se && *s != '>') s++;
                    if (s < se) s++;
                    continue;
                }
                if (starts_ci(s+1, se-s-1, "/nowiki", 7)) {
                    while (s < se && *s != '>') s++;
                    if (s < se) s++;
                    continue;
                }
                /* Extension tags that should be stripped entirely in pre-pass.
                   This ensures they're removed BEFORE skip_table or other
                   handlers can interfere. */
                {
                    static const char *ptags[] = {"timeline","gallery","imagemap",
                        "math","score","source","syntaxhighlight",
                        "mapframe","maplink","graph","templatedata",
                        "categorytree",NULL};
                    static const int plens[] = {8,7,8,4,5,6,17,8,7,5,12,12};
                    for (int pt = 0; ptags[pt]; pt++) {
                        if (starts_ci(s+1, se-s-1, ptags[pt], plens[pt])) {
                            char pnx = s[1+plens[pt]];
                            if (pnx == '>' || pnx == ' ' || pnx == '/') {
                                const char *cl = find_close_tag(s, se, ptags[pt], plens[pt]);
                                if (!cl) DBG("PREPASS: missed close for <%s>\n", ptags[pt]);
                                if (cl) { s = cl; goto pre_done; }
                                /* Self-closing or unclosed — skip to > */
                                while (s < se && *s != '>') s++;
                                if (s < se) s++;
                                goto pre_done;
                            }
                        }
                    }
                }
            }
        pre_done:
            rp_string_putc(pre, *s);
            s++;
        }
    }

    /* Collapse newlines inside table row/cell attribute values.
       Run multiple passes until no more changes, since collapsing one \n
       can merge lines that reveal more unclosed quotes. */
    int _collapse_changed = 1;
    while (_collapse_changed) {
    _collapse_changed = 0;
    /* Collapse newlines inside table row/cell attribute values.
       Template expansion can insert newlines inside style="..." or
       class="..." attributes when sub-templates produce empty output.
       This breaks the line-by-line table handlers. Replace \n with space
       when inside a quoted attribute value on a table row/cell line. */
    {
        char *s = pre->str;
        int slen = (int)pre->len;
        for (int i = 0; i < slen; i++) {
            if (s[i] == '\n' && i + 1 < slen) {
                char nc = s[i+1];
                /* Table structure markers at line start */
                if (nc == '|' || nc == '!' || nc == '{') {
                    /* This newline starts a new table element — leave it */
                    continue;
                }
                /* Check if we're inside a table line by scanning back to
                   the previous \n and checking if that line starts with
                   |, !, or |- (table content) */
                int ls = i - 1;
                while (ls > 0 && s[ls] != '\n') ls--;
                if (ls > 0) ls++; /* past the \n */
                else ls = 0;
                /* Skip sentinels at line start */
                int lp = ls;
                while (lp < i && (s[lp] == '\x01' || s[lp] == '\x02')) lp++;
                /* Table lines (| or !) with unclosed quotes: join next line */
                if (lp < i && (s[lp] == '|' || s[lp] == '!')) {
                    int quotes = 0;
                    for (int k = ls; k < i; k++) {
                        if (s[k] == '"') quotes++;
                    }
                    if (quotes % 2 == 1) {
                        s[i] = ' ';
                        _collapse_changed = 1;
                    }
                }
                /* \n followed by ;" or "| is always a broken CSS value
                   continuation — never article text.
                   ;"\n → style="...color:gray\n;"  (CSS separator + close quote)
                   "|\n → ...color: #ffb6c1\n" |    (close quote + cell separator) */
                if (i + 1 < slen) {
                    char n1 = s[i+1];
                    char n2 = (i + 2 < slen) ? s[i+2] : 0;
                    if (n1 == ';' && (n2 == '"' || n2 == ' ')) {
                        s[i] = ' '; _collapse_changed = 1;
                    } else if (n1 == '"' && (n2 == '|' || n2 == ' ' || n2 == '}')) {
                        s[i] = ' '; _collapse_changed = 1;
                    }
                }
            }
        }
    }
    } /* end while (_collapse_changed) */


    const char *p = pre->str;
    const char *end = pre->str + pre->len;

    char last = '\n';       /* last character written (start as if after newline) */
    int consec_nl = 0;      /* consecutive newlines written */
    int line_alpha = 0;     /* does current line have alphabetic content? */
    int line_start_pos = 0; /* position in out where current line started */
    int skip_table = 0;     /* >0 = inside unbalanced table, counting depth */
    int st_in_tpl = 0;     /* sentinel depth while inside skip_table */
    int tpl_depth = 0;     /* sentinel depth tracking in main loop */

    while (p < end) {
        /* If we're inside an unbalanced table, skip everything until
           the table depth returns to 0.  Track nested {|/|} at line start.
           Stop also at section headers (== ...) as a safety bail-out.
           Sentinels: skip through template regions, but stop when we
           reach article text (outside any sentinel region). */
        if (skip_table > 0) {
            if (*p == '\x01') { st_in_tpl++; p++; continue; }
            if (*p == '\x02') { if (st_in_tpl > 0) st_in_tpl--; p++; continue; }
            /* Outside template output: non-whitespace = article text → stop */
            if (st_in_tpl == 0 && *p != '\n' && *p != ' ' && *p != '\t') {
                skip_table = 0;
                goto resume_normal;
            }
            if (*p == '\n') { p++; continue; }
            if (at_line_start(p, pre->str)) {
                if (p + 1 < end && p[0] == '{' && p[1] == '|') {
                    skip_table++;
                    p += 2;
                    while (p < end && *p != '\n') p++;
                    continue;
                }
                if (p + 1 < end && p[0] == '|' && p[1] == '}') {
                    skip_table--;
                    p += 2;
                    continue;
                }
                if (p + 1 < end && p[0] == '=' && p[1] == '=') {
                    skip_table = 0; /* bail out at section header */
                    goto resume_normal;
                }
            }
            /* Skip this character (table content) */
            p++;
            continue;
        }
    resume_normal:

        unsigned char c = (unsigned char)*p;

        /* Sentinel bytes: pass through to output (used by line filter to
           identify template-originated lines for table debris stripping) */
        if (c == '\x01') { tpl_depth++; rp_string_putc(out, c); p++; continue; }
        if (c == '\x02') { if (tpl_depth > 0) tpl_depth--; rp_string_putc(out, c); p++; continue; }

        switch (c) {

        case '<':
            /* HTML constructs */
            /* <!-- comment --> — skip sentinels between < and !-- since
               template boundaries can insert \x01\x02 there */
            {
                const char *cp = p + 1;
                while (cp < end && (*cp == '\x01' || *cp == '\x02')) cp++;
                if (cp + 2 < end && cp[0] == '!' && cp[1] == '-' && cp[2] == '-') {
                    const char *close = strstr(cp + 3, "-->");
                    if (close) { p = close + 3; }
                    else { while (p < end && *p != '\n') p++; }
                    break;
                }
            }
            if (p + 4 < end && starts_ci(p + 1, end - p - 1, "ref", 3) &&
                (p[4] == ' ' || p[4] == '/' || p[4] == '>')) {
                /* <ref ... /> or <ref>...</ref> */
                const char *q = p + 4;
                int selfclose = 0;
                while (q < end && *q != '>') {
                    if (*q == '/' && q + 1 < end && q[1] == '>') { selfclose = 1; break; }
                    q++;
                }
                if (selfclose) { p = q + 2; break; }
                if (q < end && *q == '>') {
                    const char *close = find_close_tag(q + 1, end, "ref", 3);
                    if (close) { p = close; break; }
                    p = q + 1; break;
                }
                p = q; break;
            }
            if (p + 1 < end && isalpha((unsigned char)p[1])) {
                /* Check strip-entirely tags */
                static const char *stags[] = {"gallery","imagemap","nowiki","source",
                                              "syntaxhighlight","math","score","timeline",
                                              "noinclude","templatestyles",
                                              "mapframe","maplink","graph",
                                              "templatedata","categorytree",NULL};
                static const int slens[] = {7,8,6,6,17,4,5,8,9,14,8,7,5,12,12};
                for (int t = 0; stags[t]; t++) {
                    if (starts_ci(p+1, end-p-1, stags[t], slens[t])) {
                        char nx = p[1+slens[t]];
                        if (nx == '>' || nx == ' ' || nx == '/') {
                            const char *gt = memchr(p, '>', end - p);
                            if (gt) {
                                if (gt > p && *(gt-1) == '/') { p = gt + 1; goto done_char; }
                                const char *cl = find_close_tag(gt+1, end, stags[t], slens[t]);
                                if (cl) { p = cl; goto done_char; }
                                p = gt + 1; goto done_char;
                            }
                        }
                    }
                }
                /* <br> -> newline */
                if (starts_ci(p+1, end-p-1, "br", 2)) {
                    const char *q = p + 3;
                    while (q < end && *q != '>') q++;
                    if (q < end) {
                        EMIT_CHAR(out, '\n', last, consec_nl, line_alpha, line_start_pos);
                        p = q + 1; break;
                    }
                }
            }
            /* Generic HTML tag — strip tag, keep content */
            if (p + 1 < end && (isalpha((unsigned char)p[1]) || p[1] == '/')) {
                const char *gt = memchr(p, '>', end - p);
                if (gt && (gt - p) < 2000) { p = gt + 1; break; }
            }
            /* Not a tag, emit literal < */
            EMIT_CHAR(out, '<', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case '{':
            if (p + 1 < end && p[1] == '|') {
                /* {| table |} — strip if balanced, otherwise skip the {| */
                /* Scan for matching |}.  Only count {| and |} at line start. */
                int depth = 1;
                const char *q = p + 2;
                while (q + 1 < end && depth > 0) {
                    if (q[0] == '{' && q[1] == '|' &&
                        at_line_start(q, pre->str)) { depth++; q += 2; }
                    else if (q[0] == '|' && q[1] == '}' &&
                             at_line_start(q, pre->str)) { depth--; q += 2; }
                    else q++;
                }
                if (depth == 0) {
                    p = q; break; /* balanced — skip the table */
                }
                /* Unbalanced table — set skip_table depth counter.
                   The main loop will skip all content (including text that
                   looks like prose but is really inside the table) until
                   |} at line start brings the depth back to 0. */
                skip_table = 1;
                st_in_tpl = tpl_depth; /* inherit current sentinel depth */
                p += 2;
                /* Skip rest of the {| line (attributes like class="..") */
                while (p < end && *p != '\n') p++;
                break;
            }
            /* All {{ and {{{ already consumed by finalize_text.
               Any remaining { is literal. */
            EMIT_CHAR(out, '{', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case '}':
            /* All }} and }}} already consumed by finalize_text. */
            EMIT_CHAR(out, '}', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case '[': {
            /* All [[ ]] already consumed by strip_wiki_markup.
               Handle [external links] and stray [ */
            /* Interwiki project links [Commons:...] — strip entirely */
            if (p + 1 < end && p[1] != '[' &&
                (starts_ci(p+1, end-p-1, "commons:", 8) ||
                 starts_ci(p+1, end-p-1, "wikisource:", 11) ||
                 starts_ci(p+1, end-p-1, "wiktionary:", 11) ||
                 starts_ci(p+1, end-p-1, "wikibooks:", 10) ||
                 starts_ci(p+1, end-p-1, "wikiversity:", 12) ||
                 starts_ci(p+1, end-p-1, "wikispecies:", 12))) {
                const char *q = memchr(p + 1, ']', end - p - 1);
                if (q) { p = q + 1; break; }
            }
            /* Protocol-relative links [//...] — extract label */
            if (p + 2 < end && p[1] == '/' && p[2] == '/') {
                const char *q = p + 3;
                while (q < end && *q != ' ' && *q != ']') q++;
                if (q < end && *q == ' ') {
                    q++;
                    const char *label = q;
                    while (q < end && *q != ']') q++;
                    for (const char *k = label; k < q; k++)
                        EMIT_CHAR(out, *k, last, consec_nl, line_alpha, line_start_pos);
                    if (q < end) q++;
                    p = q; break;
                } else if (q < end && *q == ']') {
                    p = q + 1; break;
                }
            }
            if (p + 1 < end && p[1] != '[' && starts_ci(p+1, end-p-1, "http", 4)) {
                /* [external link] — skip HTML tags inside URL */
                const char *q = p + 1;
                while (q < end && *q != ' ' && *q != ']') {
                    if (*q == '<' && q + 1 < end && (isalpha((unsigned char)q[1]) || q[1] == '/')) {
                        while (q < end && *q != '>') q++;
                        if (q < end) q++;
                    } else {
                        q++;
                    }
                }
                if (q < end && *q == ' ') {
                    q++;
                    const char *label = q;
                    while (q < end && *q != ']') q++;
                    for (const char *k = label; k < q; k++) {
                        /* Strip HTML tags that leaked into link labels
                           from expanded template output */
                        if (*k == '<' && k + 1 < q && (isalpha((unsigned char)k[1]) || k[1] == '/')) {
                            while (k < q && *k != '>') k++;
                            continue;
                        }
                        EMIT_CHAR(out, *k, last, consec_nl, line_alpha, line_start_pos);
                    }
                    if (q < end) q++;
                    p = q; break;
                } else if (q < end && *q == ']') {
                    p = q + 1; break;
                }
            }
            EMIT_CHAR(out, '[', last, consec_nl, line_alpha, line_start_pos);
            p++; break;
        }

        case ']':
            EMIT_CHAR(out, ']', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case '\'':
            if (p + 1 < end && p[1] == '\'') {
                /* Skip bold/italic apostrophes */
                while (p < end && *p == '\'') p++;
                break;
            }
            EMIT_CHAR(out, '\'', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case '=':
            if (last == '\n' || (out->len == line_start_pos)) {
                /* Possible section header */
                int eqn = 0;
                const char *q = p;
                while (q < end && *q == '=') { eqn++; q++; }
                if (eqn >= 2) {
                    while (q < end && *q == ' ') q++;
                    const char *eol = q;
                    while (eol < end && *eol != '\n') eol++;
                    /* Truncate at <!-- if present (comment in header) */
                    const char *cmt = (const char *)memmem(q, eol - q, "<!--", 4);
                    const char *te = cmt ? cmt : eol;
                    while (te > q && *(te-1) == ' ') te--;
                    while (te > q && *(te-1) == '=') te--;
                    while (te > q && *(te-1) == ' ') te--;
                    /* Paragraph break + title + paragraph break */
                    EMIT_CHAR(out, '\n', last, consec_nl, line_alpha, line_start_pos);
                    EMIT_CHAR(out, '\n', last, consec_nl, line_alpha, line_start_pos);
                    for (const char *k = q; k < te; k++)
                        EMIT_CHAR(out, *k, last, consec_nl, line_alpha, line_start_pos);
                    EMIT_CHAR(out, '\n', last, consec_nl, line_alpha, line_start_pos);
                    EMIT_CHAR(out, '\n', last, consec_nl, line_alpha, line_start_pos);
                    p = (eol < end) ? eol + 1 : eol;
                    break;
                }
            }
            EMIT_CHAR(out, '=', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case '|':
            if (last == '\n' || out->len == (size_t)line_start_pos) {
                /* Wiki table cell at line start: | [attrs |] content
                   or || for inline cells.  Parse the cell, skip attributes,
                   emit only content. */
                p++; /* skip the cell-opening | */
                /* Check for || or ||| etc (inline cell separators, possibly
                   from empty Lua templates collapsing multiple || into |||) */
                if (p < end && *p == '|') {
                    /* Skip all consecutive | (handles ||, |||, etc.) */
                    while (p < end && *p == '|') p++;
                    while (p < end && *p == ' ') p++;
                    /* Parse cell: scan for attrs | content */
                    const char *scan = p;
                    int has_eq = 0, found_pipe = 0;
                    while (scan < end && *scan != '\n') {
                        if (*scan == '|' && scan + 1 < end && scan[1] == '|') {
                            if (has_eq) found_pipe = 1;
                            break;
                        }
                        if (*scan == '|') { found_pipe = 1; break; }
                        if (*scan == '=' || *scan == ':') has_eq = 1;
                        if (*scan == '[' && scan + 1 < end && scan[1] == '[') break;
                        scan++;
                    }
                    if (found_pipe && has_eq) {
                        p = scan + 1;
                        while (p < end && *p == ' ') p++;
                    }
                    break;
                }
                if (p < end && *p == '+') {
                    /* |+ = table caption. Skip attributes, keep caption text. */
                    p++; /* skip + */
                    while (p < end && *p == ' ') p++;
                    /* Check for attrs | content pattern */
                    const char *scan = p;
                    int has_eq = 0, found_pipe = 0;
                    while (scan < end && *scan != '\n') {
                        if (*scan == '|') { found_pipe = 1; break; }
                        if (*scan == '=' || *scan == ':') has_eq = 1;
                        scan++;
                    }
                    if (found_pipe && has_eq) {
                        p = scan + 1;
                        while (p < end && *p == ' ') p++;
                    }
                    break;
                }
                if (p < end && *p == '-') {
                    /* |- = row separator, skip rest of line */
                    while (p < end && *p != '\n') p++;
                    break;
                }
                if (p < end && *p == '}') {
                    /* |} = table close, skip */
                    p++;
                    break;
                }
                /* Scan forward to find the attribute/content separator |
                   (single |, not || and not end of line).
                   If the text before | contains =, it's attributes — skip to after |.
                   If no = before |, the content starts here (no attributes). */
                {
                    const char *scan = p;
                    int has_eq = 0;
                    int found_pipe = 0;
                    while (scan < end && *scan != '\n') {
                        if (*scan == '|' && scan + 1 < end && scan[1] == '|') {
                            break; /* || = next cell, stop scanning */
                        }
                        if (*scan == '|') { found_pipe = 1; break; }
                        if (*scan == '=' || *scan == ':') has_eq = 1;
                        /* Don't scan past [[ (link content may have |) */
                        if (*scan == '[' && scan + 1 < end && scan[1] == '[') break;
                        scan++;
                    }
                    if (found_pipe && has_eq) {
                        /* Attributes before |, content after — skip to content */
                        p = scan + 1;
                        while (p < end && *p == ' ') p++; /* trim leading spaces */
                    } else if (has_eq && !found_pipe) {
                        /* Cell has only attributes, no content separator.
                           e.g. "| variant=2\n" — skip the attributes entirely. */
                        p = scan;
                        while (p < end && *p != '\n') p++;
                    }
                    /* else: no attributes, content starts at p (after cell marker) */
                    while (p < end && *p == ' ') p++; /* trim leading spaces */
                }
                break;
            }
            /* Mid-line | — check for || or ||| (inline cell separator,
               possibly with extra | from empty Lua templates) */
            if (p + 1 < end && p[1] == '|') {
                /* Skip all consecutive | */
                while (p < end && *p == '|') p++;
                while (p < end && *p == ' ') p++;
                /* Scan for attribute/content separator like line-start cells.
                   For |||: the scan may hit || — if we've seen =, the first
                   | of the || is the attr separator (found_pipe). */
                const char *scan = p;
                int has_eq = 0, found_pipe = 0;
                while (scan < end && *scan != '\n') {
                    if (*scan == '|' && scan + 1 < end && scan[1] == '|') {
                        if (has_eq) found_pipe = 1; /* first | of || is attr sep */
                        break;
                    }
                    if (*scan == '|') { found_pipe = 1; break; }
                    if (*scan == '=' || *scan == ':') has_eq = 1;
                    if (*scan == '[' && scan + 1 < end && scan[1] == '[') break;
                    scan++;
                }
                if (found_pipe && has_eq) {
                    p = scan + 1;
                    while (p < end && *p == ' ') p++;
                }
                /* Emit a space to separate from previous cell content */
                EMIT_CHAR(out, ' ', last, consec_nl, line_alpha, line_start_pos);
                break;
            }
            /* Single mid-line | — could be a cell start from |||
               (empty template between || and |).  Check for attrs | content. */
            {
                const char *scan = p + 1;
                while (scan < end && *scan == ' ') scan++;
                int has_eq = 0, found_pipe = 0;
                while (scan < end && *scan != '\n') {
                    if (*scan == '|' && scan + 1 < end && scan[1] == '|') {
                        if (has_eq) found_pipe = 1;
                        break;
                    }
                    if (*scan == '|') { found_pipe = 1; break; }
                    if (*scan == '=' || *scan == ':') has_eq = 1;
                    if (*scan == '[' && scan + 1 < end && scan[1] == '[') break;
                    scan++;
                }
                if (found_pipe && has_eq) {
                    /* Cell attributes found — skip to content */
                    p = (char *)scan + 1;
                    while (p < end && *p == ' ') p++;
                    EMIT_CHAR(out, ' ', last, consec_nl, line_alpha, line_start_pos);
                    break;
                }
            }
            EMIT_CHAR(out, ' ', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case '!':
            if (last == '\n' || out->len == (size_t)line_start_pos) {
                /* Wiki table header cell at line start: ! [attrs |] content
                   Same as | but uses ! as cell marker and | as attr separator. */
                p++; /* skip the ! */
                if (p < end && *p == '!') { p++; } /* !! at line start — skip both, fall through to attr parse */
                {
                    const char *scan = p;
                    int has_eq = 0;
                    int found_pipe = 0;
                    while (scan < end && *scan != '\n') {
                        if (*scan == '!' && scan + 1 < end && scan[1] == '!') break;
                        if (*scan == '|') { found_pipe = 1; break; }
                        if (*scan == '=' || *scan == ':') has_eq = 1;
                        if (*scan == '[' && scan + 1 < end && scan[1] == '[') break;
                        scan++;
                    }
                    if (found_pipe) {
                        /* Everything before | is attributes — skip to content */
                        p = scan + 1;
                        while (p < end && *p == ' ') p++;
                    } else if (has_eq) {
                        /* Header cell with only attributes, no content */
                        p = scan;
                        while (p < end && *p != '\n') p++;
                    }
                    while (p < end && *p == ' ') p++;
                }
                break;
            }
            /* Mid-line ! — check for !! (inline header separator) */
            if (p + 1 < end && p[1] == '!') {
                p += 2;
                while (p < end && *p == ' ') p++;
                const char *scan = p;
                int has_eq = 0, found_pipe = 0;
                while (scan < end && *scan != '\n') {
                    if (*scan == '!' && scan + 1 < end && scan[1] == '!') break;
                    if (*scan == '|') { found_pipe = 1; break; }
                    if (*scan == '=' || *scan == ':') has_eq = 1;
                    if (*scan == '[' && scan + 1 < end && scan[1] == '[') break;
                    scan++;
                }
                if (found_pipe) {
                    p = scan + 1;
                    while (p < end && *p == ' ') p++;
                }
                EMIT_CHAR(out, ' ', last, consec_nl, line_alpha, line_start_pos);
                break;
            }
            EMIT_CHAR(out, '!', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case '*': case ':': case ';':
            if (last == '\n' || (out->len == line_start_pos)) {
                /* List/indent markers at start of line — skip */
                while (p < end && (*p == '*' || *p == '#' || *p == ':' || *p == ';')) p++;
                while (p < end && *p == ' ') p++;
                break;
            }
            EMIT_CHAR(out, *p, last, consec_nl, line_alpha, line_start_pos);
            p++; break;


        case '#':
            if (last == '\n' || (out->len == line_start_pos)) {
                /* List markers at start of line */
                while (p < end && (*p == '*' || *p == '#' || *p == ':' || *p == ';')) p++;
                while (p < end && *p == ' ') p++;
                break;
            }
            /* #invoke: — Lua module call debris, skip to end of line or next delimiter */
            if (p + 7 < end && starts_ci(p + 1, end - p - 1, "invoke:", 7)) {
                while (p < end && *p != '\n' && *p != ']' && *p != '}') p++;
                break;
            }
            /* Treat # at line start as list marker (already handled above)
               but #if:, #switch:, #expr: etc mid-line — skip to next delimiter */
            if (p + 3 < end && (
                starts_ci(p + 1, end - p - 1, "if:", 3) ||
                starts_ci(p + 1, end - p - 1, "ifeq:", 5) ||
                starts_ci(p + 1, end - p - 1, "switch:", 7) ||
                starts_ci(p + 1, end - p - 1, "expr:", 5))) {
                while (p < end && *p != '\n' && *p != ']' && *p != '}' && *p != '|') p++;
                break;
            }
            EMIT_CHAR(out, '#', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case '_':
            if (p + 3 < end && p[1] == '_') {
                /* __BEHAVIOR_SWITCH__ */
                const char *q = p + 2;
                while (q < end && *q >= 'A' && *q <= 'Z') q++;
                if (q + 1 < end && q[0] == '_' && q[1] == '_' && (q - p - 2) >= 3) {
                    p = q + 2; break;
                }
            }
            EMIT_CHAR(out, '_', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case '-':
            /* ---- horizontal rule (4+ hyphens at line start) */
            if ((last == '\n' || out->len == (size_t)line_start_pos) &&
                p + 3 < end && p[1] == '-' && p[2] == '-' && p[3] == '-') {
                while (p < end && *p == '-') p++;
                /* Emit paragraph break */
                EMIT_CHAR(out, '\n', last, consec_nl, line_alpha, line_start_pos);
                break;
            }
            EMIT_CHAR(out, '-', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case '\n':
            EMIT_CHAR(out, '\n', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case ' ': case '\t': case '\r': case '\f': case '\v':
            EMIT_CHAR(out, ' ', last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        case 0xC2:
            if (p + 1 < end && (unsigned char)p[1] == 0xA0) {
                EMIT_CHAR(out, ' ', last, consec_nl, line_alpha, line_start_pos);
                p += 2; break;
            }
            goto emit_default;

        case 0xE2:
            if (p + 2 < end) {
                unsigned char b2 = p[1], b3 = p[2];
                if (b2 == 0x80 && ((b3 >= 0x80 && b3 <= 0x8D) || b3 == 0xA8 ||
                    b3 == 0xA9 || b3 == 0xAF)) {
                    EMIT_CHAR(out, ' ', last, consec_nl, line_alpha, line_start_pos);
                    p += 3; break;
                }
                if (b2 == 0x81 && b3 == 0x9F) {
                    EMIT_CHAR(out, ' ', last, consec_nl, line_alpha, line_start_pos);
                    p += 3; break;
                }
            }
            goto emit_default;

        case 0xE3:
            if (p + 2 < end && (unsigned char)p[1] == 0x80 && (unsigned char)p[2] == 0x80) {
                EMIT_CHAR(out, ' ', last, consec_nl, line_alpha, line_start_pos);
                p += 3; break;
            }
            goto emit_default;

        case 0xEF:
            if (p + 2 < end && (unsigned char)p[1] == 0xBB && (unsigned char)p[2] == 0xBF) {
                p += 3; break; /* BOM — skip */
            }
            goto emit_default;

        /* \x01/\x02 sentinels no longer present — stripped in flatten pass */

        default:
        emit_default:
            EMIT_CHAR(out, *p, last, consec_nl, line_alpha, line_start_pos);
            p++; break;

        done_char:
            break;
        }
    }

    /* Trim trailing whitespace */
    while (out->len > 0 && (out->str[out->len-1] == '\n' || out->str[out->len-1] == ' '))
        out->len--;
    out->str[out->len] = '\0';

    /* Decode HTML entities in-place */
    out->len = decode_html_entities_utf8(out->str, NULL);

    /* Entity decode may reintroduce HTML tags and wiki markup — strip them */
    {
        rp_string *final = rp_string_new(out->len + 64);
        const char *s = out->str;
        int slen = (int)out->len;
        int i = 0;
        while (i < slen) {
            if (s[i] == '<' && i + 1 < slen && (isalpha((unsigned char)s[i+1]) || s[i+1] == '/')) {
                /* Strip HTML tags */
                while (i < slen && s[i] != '>') i++;
                if (i < slen) i++;

#ifdef POST_ENTITY_LINK_STRIP
            /* Retained for possible future use: strip [[...]] and [url label]
               that entity decode might create from &#91;/&#93;.  Currently not
               needed because the external-link handler in the main cleanup
               loop skips sentinels when peeking for "http" after "[". */
            } else if (s[i] == '[' && i + 1 < slen && s[i+1] == '[') {
                int j = i + 2;
                int depth = 1;
                while (j + 1 < slen && depth > 0) {
                    if (s[j] == '[' && s[j+1] == '[') { depth++; j += 2; }
                    else if (s[j] == ']' && s[j+1] == ']') { depth--; if (depth > 0) j += 2; }
                    else j++;
                }
                if (depth == 0) {
                    int last_pipe = -1;
                    for (int k = i + 2; k < j; k++)
                        if (s[k] == '|') last_pipe = k;
                    int start = (last_pipe >= 0) ? last_pipe + 1 : i + 2;
                    rp_string_putsn(final, s + start, j - start);
                    i = j + 2;
                } else {
                    i += 2;
                }
            } else if (s[i] == '[' && i + 1 < slen &&
                       (s[i+1] == 'h' || s[i+1] == 'f')) {
                int j = i + 1;
                int space = -1;
                while (j < slen && s[j] != ']' && s[j] != '\n') {
                    if (s[j] == ' ' && space < 0) space = j;
                    j++;
                }
                if (j < slen && s[j] == ']') {
                    if (space >= 0)
                        rp_string_putsn(final, s + space + 1, j - space - 1);
                    i = j + 1;
                } else {
                    rp_string_putc(final, s[i]);
                    i++;
                }
#endif
            } else {
                rp_string_putc(final, s[i]);
                i++;
            }
        }
        rp_string_clear(out);
        rp_string_putsn(out, final->str, final->len);
        rp_string_free(final);
    }

    /* Quick line filter: strip sentinels, remove debris lines.
       Sentinels (\x01/\x02) survived through the main loop so we can
       identify template-originated lines and strip table debris from them. */
    {
        rp_string *tmp = rp_string_new(out->len + 64);
        const char *s = out->str;
        int slen = (int)out->len;
        int i = 0;
        int tpl_depth = 0;  /* sentinel depth tracking */
        while (i < slen) {
            /* Track sentinels and strip them from output */
            if (s[i] == '\x01') { tpl_depth++; i++; continue; }
            if (s[i] == '\x02') { if (tpl_depth > 0) tpl_depth--; i++; continue; }
            int ls = i;
            int line_from_tpl = tpl_depth > 0;
            while (i < slen && s[i] != '\n') {
                if (s[i] == '\x01') { tpl_depth++; line_from_tpl = 1; }
                else if (s[i] == '\x02') { if (tpl_depth > 0) tpl_depth--; line_from_tpl = 1; }
                i++;
            }
            int le = i;
            if (i < slen) i++;
            /* Trim for check (skip sentinel bytes) */
            int ts = ls, te = le;
            while (ts < te && (s[ts] == ' ' || s[ts] == '\x01' || s[ts] == '\x02')) ts++;
            while (te > ts && (s[te-1] == ' ' || s[te-1] == '\x01' || s[te-1] == '\x02')) te--;
            int tlen = te - ts;
            /* Lines with style="...css-property:..." are always HTML attribute
               fragments from table templates — the style=" with opening quote
               followed by a CSS property is structurally impossible in prose. */
            if (tlen > 10 && memmem(s+ts, tlen, "style=\"", 7)) {
                /* Verify there's an actual CSS property inside */
                const char *_sq = memmem(s+ts, tlen, "style=\"", 7);
                if (_sq) {
                    const char *_after = _sq + 7;
                    int _rem = tlen - (int)(_after - (s+ts));
                    if (_rem > 5 && (
                        memmem(_after, _rem, "background", 10) ||
                        memmem(_after, _rem, "text-align", 10) ||
                        memmem(_after, _rem, "font-size", 9) ||
                        memmem(_after, _rem, "vertical-align", 14) ||
                        memmem(_after, _rem, "border", 6) ||
                        memmem(_after, _rem, "padding", 7) ||
                        memmem(_after, _rem, "margin", 6) ||
                        memmem(_after, _rem, "color:", 6) ||
                        memmem(_after, _rem, "width:", 6) ||
                        memmem(_after, _rem, "height:", 7) ||
                        memmem(_after, _rem, "display:", 8) ||
                        memmem(_after, _rem, "float:", 6) ||
                        memmem(_after, _rem, "position:", 9)))
                        continue;
                }
            }
            /* Template-originated lines: strip HTML table attributes and
               other debris that leaks from split-template tables.
               Only applied to lines inside sentinel regions (template output)
               to avoid stripping legitimate article text about CSS/HTML. */
            /* Template error messages and broken comments — never article prose */
            if (tlen > 15 && (
                memmem(s+ts, tlen, "unrecognized country", 20) ||
                memmem(s+ts, tlen, "Page using Template:", 20) ||
                memmem(s+ts, tlen, "unknown parameter", 17)))
                continue;
            /* Broken HTML comments: <!- - or !-- ... --> (the < may have been
               stripped by the HTML tag handler, leaving orphaned comments) */
            if (tlen > 4 && memmem(s+ts, tlen, "-->", 3) &&
                (memmem(s+ts, tlen, "<!-", 3) || memmem(s+ts, tlen, "!--", 3)))
                continue;

            if (line_from_tpl && tlen > 3) {
                /* HTML table attributes */
                if (memmem(s+ts, tlen, "bgcolor", 7) ||
                    memmem(s+ts, tlen, "cellspacing", 11) ||
                    memmem(s+ts, tlen, "cellpadding", 11) ||
                    memmem(s+ts, tlen, "rowspan=", 8) ||
                    memmem(s+ts, tlen, "colspan=", 8) ||
                    memmem(s+ts, tlen, "align=\"", 7) ||
                    memmem(s+ts, tlen, "valign=", 7) ||
                    memmem(s+ts, tlen, "scope=\"", 7) ||
                    memmem(s+ts, tlen, "nowrap", 6) ||
                    memmem(s+ts, tlen, "width=\"", 7) ||
                    memmem(s+ts, tlen, "height=\"", 8) ||
                    memmem(s+ts, tlen, "border=\"", 8))
                    continue;
                /* CSS properties */
                if (memmem(s+ts, tlen, "background-color:", 17) ||
                    memmem(s+ts, tlen, "background:", 11) ||
                    memmem(s+ts, tlen, "text-align:", 11) ||
                    memmem(s+ts, tlen, "vertical-align:", 15) ||
                    memmem(s+ts, tlen, "border-collapse", 15) ||
                    memmem(s+ts, tlen, "font-size:", 10) ||
                    memmem(s+ts, tlen, "font-weight:", 12) ||
                    memmem(s+ts, tlen, "font-style:", 11) ||
                    memmem(s+ts, tlen, "line-height:", 12) ||
                    memmem(s+ts, tlen, "padding:", 8) ||
                    memmem(s+ts, tlen, "padding-", 8) ||
                    memmem(s+ts, tlen, "margin:", 7) ||
                    memmem(s+ts, tlen, "margin-", 7) ||
                    memmem(s+ts, tlen, "border:", 7) ||
                    memmem(s+ts, tlen, "border-", 7) ||
                    memmem(s+ts, tlen, "color:", 6) ||
                    memmem(s+ts, tlen, "display:", 8) ||
                    memmem(s+ts, tlen, "float:", 6) ||
                    memmem(s+ts, tlen, "overflow:", 9) ||
                    memmem(s+ts, tlen, "white-space:", 12) ||
                    memmem(s+ts, tlen, "text-decoration:", 16) ||
                    memmem(s+ts, tlen, "text-indent:", 12) ||
                    memmem(s+ts, tlen, "max-width:", 10) ||
                    memmem(s+ts, tlen, "min-width:", 10) ||
                    memmem(s+ts, tlen, "position:", 9) ||
                    memmem(s+ts, tlen, "z-index:", 8) ||
                    memmem(s+ts, tlen, "opacity:", 8) ||
                    memmem(s+ts, tlen, "cursor:", 7) ||
                    memmem(s+ts, tlen, "visibility:", 11))
                    continue;
                /* HTML class/style attributes */
                if (memmem(s+ts, tlen, "class=\"", 7) ||
                    memmem(s+ts, tlen, "style=\"", 7) ||
                    memmem(s+ts, tlen, "stroke-width", 12))
                    continue;
                /* JSON/map debris */
                if (memmem(s+ts, tlen, "ExternalData", 12) ||
                    memmem(s+ts, tlen, "\"geoshape\"", 10))
                    continue;
                /* Line starting with " is always a broken attribute fragment */
                if (s[ts] == '"') continue;
            }
            /* Discard bare HTML attribute values that leak as single words */
            if (tlen == 5 && strncasecmp(s+ts, "vcard", 5) == 0) continue;
            /* Discard lines starting with a leaked template/CSS name.
               When {{templatename|content}} fails to expand, the text
               becomes "templatename content" after {{, }}, | are stripped.
               Filter lines starting with known formatting template or
               CSS class names followed by space or end-of-line. */
            {
                static const char *leaked[] = {
                    "nowrap","noprint","plainlist","hlist","plainlinks",
                    "vcard","navbox","sidebar","infobox","collapsible",
                    "autocollapse","collapsed","mw-collapsible","vevent",
                    "geoshape",NULL};
                static const int llens[] = {6,7,9,5,10,5,6,7,7,11,12,9,14,6,8};
                int _leaked = 0;
                for (int lk = 0; leaked[lk]; lk++) {
                    if (tlen >= llens[lk] &&
                        strncasecmp(s+ts, leaked[lk], llens[lk]) == 0 &&
                        (tlen == llens[lk] || s[ts+llens[lk]] == ' '))
                        { _leaked = 1; break; }
                }
                if (_leaked) continue;
            }
            /* Discard lines that are CSS class lists (contain multiple
               CSS infrastructure class names from infobox templates) */
            if (tlen > 30 && (memmem(s+ts, tlen, "mergedrow", 9) ||
                              memmem(s+ts, tlen, "mergedtop", 9) ||
                              memmem(s+ts, tlen, "ib-settlement", 13))) continue;
            /* Discard lines ending with CSS class names (e.g. "... noprint nowrap") */
            if (tlen > 10 && te - 6 >= ts && strncmp(s + te - 6, "nowrap", 6) == 0) continue;
            if (tlen > 10 && te - 7 >= ts && strncmp(s + te - 7, "noprint", 7) == 0) continue;
            /* Discard short lines ending with = (template param stubs) */
            if (tlen > 0 && tlen < 40 && s[te-1] == '=') continue;
            /* Discard lines with "> (broken HTML tag fragments) */
            if (tlen > 1 && s[ts] == '"' && s[ts+1] == '>') continue;
            if (tlen > 2 && s[te-2] == '"' && s[te-1] == '>') continue;
            /* Discard CSS property debris: word-word:value; patterns.
               Check for lowercase-alpha-hyphen word immediately followed by : */
            if (tlen > 0 && memmem(s+ts, tlen, ";", 1)) {
                int _is_css = 0;
                for (int _k = ts + 1; _k < te; _k++) {
                    if (s[_k] == ':' && s[_k-1] != ' ') {
                        /* char before : is non-space — check if it's a CSS name */
                        int _w = _k - 1;
                        while (_w > ts && ((s[_w] >= 'a' && s[_w] <= 'z') || s[_w] == '-'))
                            _w--;
                        if (_k - _w > 3) { _is_css = 1; break; } /* word >= 3 chars before : */
                    }
                }
                if (_is_css) continue;
            }
            /* Discard wiki table structure from split-template tables.
               These are lines that would be inside {|...|} but the {| or |}
               was lost during single-pass expansion of split-template tables.
               Safe globally — these patterns never appear in article prose. */
            if (tlen > 0 && s[ts] == '!') {
                /* Table header cell: ! or !colspan=... */
                continue;
            }
            if (tlen > 0 &&
                (memmem(s+ts, tlen < 20 ? tlen : 20, "colspan", 7) ||
                 memmem(s+ts, tlen < 20 ? tlen : 20, "rowspan", 7))) {
                /* Line starting with colspan/rowspan — table cell attribute */
                continue;
            }
            if (tlen > 5 && tlen < 80 && memmem(s+ts, tlen, "align=", 6) &&
                (memmem(s+ts, tlen, "align=\"center\"", 14) ||
                 memmem(s+ts, tlen, "align=center", 12) ||
                 memmem(s+ts, tlen, "align=\"left\"", 12) ||
                 memmem(s+ts, tlen, "align=left", 10) ||
                 memmem(s+ts, tlen, "align=\"right\"", 13) ||
                 memmem(s+ts, tlen, "align=right", 11))) {
                continue;
            }
            if (tlen > 1 && s[ts] == '|' && s[ts+1] == '-') {
                /* Table row separator: |- */
                continue;
            }
            if (tlen > 1 && s[ts] == '-' &&
                (memmem(s+ts, tlen < 20 ? tlen : 20, "bgcolor", 7) ||
                 memmem(s+ts, tlen < 20 ? tlen : 20, "style=", 6))) {
                /* Table row with attributes: -bgcolor=... or -style=...
                   from |-bgcolor after | was stripped */
                continue;
            }
            /* Discard standalone word=value or word:value or word = value lines
               (template params or CSS properties, never article text) */
            if (tlen > 2 && tlen < 40) {
                int _sep = -1;
                for (int k = 0; k < tlen; k++) {
                    if (s[ts+k] == '=' || s[ts+k] == ':') { _sep = k; break; }
                    if (s[ts+k] != ' ' && !((s[ts+k] >= 'a' && s[ts+k] <= 'z') || s[ts+k] == '-'))
                        break;
                }
                if (_sep >= 2 && _sep < tlen) {
                    int _valid = 1;
                    int _wordlen = 0;
                    for (int k = 0; k < _sep; k++) {
                        if ((s[ts+k] >= 'a' && s[ts+k] <= 'z') || s[ts+k] == '-') _wordlen++;
                        else if (s[ts+k] != ' ') { _valid = 0; break; }
                    }
                    if (_wordlen < 2) _valid = 0;
                    if (_valid) continue;
                }
            }
            /* Keep line, stripping sentinel bytes */
            {
                int line_end_with_nl = (i > le ? le + 1 : le);
                for (int _k = ls; _k < line_end_with_nl; _k++) {
                    if (s[_k] != '\x01' && s[_k] != '\x02')
                        rp_string_putc(tmp, s[_k]);
                }
            }
        }
        rp_string_clear(out);
        rp_string_putsn(out, tmp->str, tmp->len);
        rp_string_free(tmp);
    }

    /* Debris filtering now done in filter_debris() before cleanup.
       Sentinel-based pass no longer needed — text is flat. */

    rp_string_free(pre);
}
