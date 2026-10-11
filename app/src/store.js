'use strict';
// Per-game files under data/games/<id>/: game.json, profile.json, cache.json, transcript.jsonl, edits.json, zones.json
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const GAMES_DIR = path.join(DATA_DIR, 'games');
const HOST_EXES = new Set(['chrome', 'msedge', 'firefox', 'electron', 'java', 'javaw', 'python', 'pythonw', 'nw', 'node', 'applicationframehost', 'dosbox', 'retroarch']);

function slug(s) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 60).replace(/^[-.]+|[-.]+$/g, '') || 'game';
}

function gameIdFor(exeName, title) {
  const base = slug(path.parse(exeName || 'game').name.toLowerCase());
  if (HOST_EXES.has(base)) return `${base}-${slug(title).toLowerCase()}`;
  return base;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

class GameStore {
  constructor(id) {
    this.id = id;
    this.dir = path.join(GAMES_DIR, id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = (n) => path.join(this.dir, n);
    this.cache = readJson(this.file('cache.json'), { entries: [] });
    this.edits = readJson(this.file('edits.json'), {});
    this.memory = readJson(this.file('memory.json'), {});   // source text -> first translation, for consistency
    this._memTimer = null;
    this._cacheTimer = null;
  }

  get meta() { return readJson(this.file('game.json'), { id: this.id }); }
  saveMeta(patch) { const m = { ...this.meta, ...patch, id: this.id }; writeJson(this.file('game.json'), m); return m; }

  get profile() { return readJson(this.file('profile.json'), null); }
  saveProfile(p) { p.updated_at = new Date().toISOString(); writeJson(this.file('profile.json'), p); return p; }

  get zones() { return readJson(this.file('zones.json'), { ignore: [], read: [], only_read: false }); }
  saveZones(z) { writeJson(this.file('zones.json'), z); return z; }

  // Image cache: a region whose pixels hash close to a known region reuses its blocks.
  findCached(w, h, hash) {
    // Near-exact only: a different line in the same panel must never match.
    // Older 512-bit entries have a different length and never match.
    let best = null, bestD = 4;
    for (const e of this.cache.entries) {
      if (Math.abs(e.w - w) > Math.max(4, w * 0.02) || Math.abs(e.h - h) > Math.max(4, h * 0.02)) continue;
      const d = hamming(e.hash, hash);
      if (d < bestD) { best = e; bestD = d; }
    }
    if (best) best.hits = (best.hits || 0) + 1;
    return best;
  }
  putCached(w, h, hash, blocks) {
    const entries = this.cache.entries;
    const i = entries.findIndex((e) => e.w === w && e.h === h && e.hash === hash);
    const entry = { w, h, hash, blocks, at: Date.now() };
    if (i >= 0) entries[i] = entry; else entries.push(entry);
    if (entries.length > 6000) entries.splice(0, entries.length - 6000);
    this.saveCacheSoon();
  }
  updateCachedText(source, text) {
    let n = 0;
    for (const e of this.cache.entries) for (const b of e.blocks) if (b.source === source) { b.text = text; n++; }
    if (n) this.saveCacheSoon();
  }
  saveCacheSoon() {
    clearTimeout(this._cacheTimer);
    this._cacheTimer = setTimeout(() => writeJson(this.file('cache.json'), this.cache), 1500);
  }
  get cacheSize() { return this.cache.entries.reduce((n, e) => n + e.blocks.length, 0); }

  remember(source, text) {
    if (!source || this.memory[source]) return;
    this.memory[source] = text;
    clearTimeout(this._memTimer);
    this._memTimer = setTimeout(() => writeJson(this.file('memory.json'), this.memory), 1500);
  }
  recall(source) { return this.edits[source] || this.memory[source] || null; }

  saveEdit(source, text) { this.edits[source] = text; writeJson(this.file('edits.json'), this.edits); }

  appendTranscript(line) { fs.appendFileSync(this.file('transcript.jsonl'), JSON.stringify(line) + '\n', 'utf8'); }
  readTranscript(limit = 500) {
    let raw = '';
    try { raw = fs.readFileSync(this.file('transcript.jsonl'), 'utf8'); } catch { return []; }
    const rows = [];
    const byId = new Map();
    for (const l of raw.split('\n')) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        if (o.type === 'edit') { const r = byId.get(o.id); if (r) { r.was = r.was || r.text; r.text = o.text; r.edited = true; } continue; }
        rows.push(o); byId.set(o.id, o);
      } catch { /* skip */ }
    }
    return rows.slice(-limit);
  }
  flush() {
    if (this._cacheTimer) { clearTimeout(this._cacheTimer); writeJson(this.file('cache.json'), this.cache); }
    if (this._memTimer) { clearTimeout(this._memTimer); writeJson(this.file('memory.json'), this.memory); }
  }
}

function listGames() {
  let ids = [];
  try { ids = fs.readdirSync(GAMES_DIR); } catch { return []; }
  return ids.map((id) => {
    const dir = path.join(GAMES_DIR, id);
    const meta = readJson(path.join(dir, 'game.json'), null);
    if (!meta) return null;
    const profile = readJson(path.join(dir, 'profile.json'), null);
    const cache = readJson(path.join(dir, 'cache.json'), { entries: [] });
    return {
      ...meta,
      profile: profile ? {
        auto: !!profile.auto, identified: profile.identified !== false,
        characters: (profile.characters || []).length, terms: (profile.glossary || []).length,
      } : null,
      lines_cached: cache.entries.reduce((n, e) => n + e.blocks.length, 0),
    };
  }).filter(Boolean).sort((a, b) => String(b.last_played || '').localeCompare(String(a.last_played || '')));
}

module.exports = { GameStore, gameIdFor, listGames, hamming, GAMES_DIR };
