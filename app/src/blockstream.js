'use strict';
// Pulls complete objects out of a JSON reply while it is still streaming.
// Reply shape: { "blocks": [ {...}, {...} ], "new_terms": [ {...} ] }
// Each object inside a top-level array is emitted as soon as its closing brace arrives.

class BlockStream {
  constructor(onObject) {
    this.onObject = onObject;   // (arrayKey, object) => void
    this.buf = '';
    this.pos = 0;
    this.depth = 0;
    this.inStr = false;
    this.esc = false;
    this.key = null;            // last string seen at depth 1, i.e. the current top-level key
    this.strStart = -1;
    this.objStart = -1;
    this.emitted = 0;
  }

  push(text) {
    this.buf += text;
    const s = this.buf;
    for (; this.pos < s.length; this.pos++) {
      const c = s[this.pos];
      if (this.inStr) {
        if (this.esc) this.esc = false;
        else if (c === '\\') this.esc = true;
        else if (c === '"') {
          this.inStr = false;
          if (this.depth === 1) {
            try { this.key = JSON.parse(s.slice(this.strStart, this.pos + 1)); } catch { /* ignore */ }
          }
        }
        continue;
      }
      if (c === '"') { this.inStr = true; this.strStart = this.pos; continue; }
      if (c === '{' || c === '[') {
        this.depth++;
        if (c === '{' && this.depth === 3) this.objStart = this.pos;
      } else if (c === '}' || c === ']') {
        if (c === '}' && this.depth === 3 && this.objStart >= 0) {
          const raw = s.slice(this.objStart, this.pos + 1);
          this.objStart = -1;
          try { this.onObject(this.key, JSON.parse(raw)); this.emitted++; } catch { /* malformed piece, skip */ }
        }
        this.depth--;
      }
    }
  }

  // Whole reply, for a final parse once streaming ends.
  text() { return this.buf; }
}

function parseLooseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  return null;
}

module.exports = { BlockStream, parseLooseJson };
