/* splitter.js — Split parsed wiki article text into chunks for embedding.

   Usage:
     var splitter = require("splitter.js");
     var parts = splitter.split(id, title, docText);
     // returns array of { idSec: <id*1000 + n>, text: "Title [Section] body..." }
*/

var thresh = 80;  // minimum chunk size to keep standalone

// Returns true if a \n\n block is a list of short items (not prose).
function isList(s) {
    var lines = s.split('\n');
    if (lines.length < 3) return false;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (/\.\s+[A-Z]/.test(line)) return false;
        if (line.length > 80) return false;
    }
    return true;
}

// Strip the doubled short-description that the parser puts on the first line.
// Pattern: "Some descriptionSome description" — exact duplicate, no separator.
function stripDoubledDesc(line) {
    var len = line.length;
    if (len < 6 || len % 2 !== 0) return line;
    var half = len / 2;
    if (line.substring(0, half) === line.substring(half)) return "";
    return line;
}

// Strip leading noise from the first \n\n block.
// The parser produces: short-desc\ndisambig\ndate\ncaption\nFirst real sentence...
function stripLeadingJunk(s) {
    var lines = s.split('\n');

    if (lines.length > 0) {
        lines[0] = stripDoubledDesc(lines[0]);
    }

    // Find the first line that looks like prose (has ". " pattern)
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line.length) continue;
        if (/\.\s/.test(line)) {
            return lines.slice(i).join('\n');
        }
    }
    // No sentence found — block is all junk (infobox data, captions, etc.)
    return "";
}

// Sections that signal end of article prose
var endSections = ["See also", "Notes", "References", "Works cited",
    "Further reading", "External links", "Bibliography", "Sources",
    "Publications", "Selected publications", "Discography",
    "Filmography", "Awards and nominations"];

function isEndMarker(s) {
    for (var i = 0; i < endSections.length; i++) {
        if (s === endSections[i]) return true;
    }
    return false;
}

// Build final text: "Title [Section] body..."
// The section heading is the first line if it's short and not a sentence.
function buildText(title, part) {
    var lines = part.split('\n');
    var firstLine = lines[0].trim();
    var firstWords = firstLine.split(/\s+/).length;
    var heading = "";
    var body = part;

    if (firstWords <= 10 && firstLine.indexOf('.') < 0 && lines.length > 1) {
        heading = firstLine;
        body = lines.slice(1).join('\n').trim();
    }

    if (heading)
        return title + " " + heading + " " + body;
    else
        return title + " " + body;
}

function split(id, title, doc) {
    var rawparts = doc.split('\n\n');
    var parts = [];
    var secno = 0;
    var first = true;

    for (var i = 0; i < rawparts.length; i++) {
        var s = rawparts[i].trim();
        if (!s.length) continue;

        // Stop at end-of-article boilerplate sections
        if (isEndMarker(s)) break;

        // Clean up the first block
        if (first) {
            s = stripLeadingJunk(s);
            first = false;
        }

        // Skip list-only blocks
        if (isList(s)) continue;

        // Merge forward if:
        // 1. Short block (section header, caption, etc.)
        // 2. Heading+link-list block: first line <= 10 words and no period anywhere
        var mergeForward = false;
        if (s.length < thresh) {
            mergeForward = true;
        } else if (s.indexOf('.') < 0) {
            var firstLine = s.split('\n')[0].trim();
            if (firstLine.split(/\s+/).length <= 10)
                mergeForward = true;
        }

        if (mergeForward && i + 1 < rawparts.length) {
            var next = rawparts[i+1].trim();
            if (next.length > 0) {
                rawparts[i+1] = s + '\n' + next;
                continue;
            }
        }

        // Still too short or no-period junk at end — skip it
        if (s.length < thresh) continue;

        secno++;
        parts.push({
            idSec: id * 1000 + secno,
            text:  buildText(title, s)
        });
    }

    return parts;
}

module.exports = { split: split };
