'use strict';
// One play session: turns changed screen regions into painted translations.
const { getKey, exeVersionInfo, loadSettings } = require('./config');
const { translateBody, identifyBody, updateBody } = require('./requests');
const gemini = require('./gemini');
const { BlockStream, parseLooseJson } = require('./blockstream');

const COOLDOWN_MS = 30000;
const MAX_INFLIGHT = 3;

function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

// Share of the font size that a single line of this text covers from its top to its bottom pixel.
// CJK and text with descenders fill nearly all of it; capitals without descenders about 0.72;
// lowercase without ascenders or descenders only the x-height.
function letterExtent(s) {
  s = String(s || '');
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(s)) return 0.9;
  if (/[gjpqy,;()\[\]{}|]/.test(s)) return 0.95;
  if (/[A-Z0-9bdfhiklt'"!?]/.test(s)) return 0.74;
  if (/[a-z]/.test(s)) return 0.55;
  return 0.9;
}

class Session {
  constructor({ store, game, settings, engine, overlay, ui, snapshot }) {
    this.store = store;
    this.game = game;                  // { id, title, exe, exePath, hwnd }
    this.settings = settings;
    this.engine = engine;              // (channel, data) => void
    this.overlay = overlay;            // (channel, data) => void
    this.ui = ui;                      // (channel, data) => void
    this.snapshot = snapshot;          // () => Promise<{ mime, data }>
    this.profile = store.profile;
    this.pending = new Map();          // block key -> block data awaiting registration
    this.shown = new Map();            // engine block id -> block data
    this.regionMeta = new Map();       // regionId -> { w, h, hash, box, cached: [] }
    this.inflight = 0;
    this.cooldown = new Map();         // model -> until
    this.noThinking = new Set();
    this.failures = 0;
    this.lastError = null;
    this.lastErrorAt = 0;
    this.callSeq = 0;
    this.paused = false;
    this.engineStatus = { unsettled: 0 };
    this.startedAt = Date.now();
    this.transcript = store.readTranscript(400);
    this.lineSeq = this.transcript.reduce((m, l) => Math.max(m, l.id || 0), 0);
    this.stats = { lines: 0, cacheHits: 0, calls: 0, latencies: [], firstBlock: [], tokens: { prompt: 0, cached: 0, output: 0 }, last: null };
    this.newSpeakers = new Set();
    this.pendingTerms = [];
    this.conflicts = [];
    this.linesSinceUpdate = 0;
    this.lastUpdateAt = 0;
    this.updating = false;
    this.profileStatus = this.profile ? 'ready' : 'none';
    this.identifyTimer = null;
    if (!this.profile && settings.profile.identify_on_first_play) {
      this.profileStatus = 'waiting';
      this.identifyTimer = setTimeout(() => this.identify(), 20000);
    }
  }

  dispose() { clearTimeout(this.identifyTimer); this.store.flush(); }

  pair() {
    const t = this.settings.languages.target;
    const map = { 'zh-Hans': '中文', 'zh-Hant': '中文', en: 'EN', ja: '日本語', ko: '한국어' };
    return `${(this.settings.languages.source === 'auto' ? 'Auto' : this.settings.languages.source.toUpperCase())} → ${map[t] || t}`;
  }

  hud() {
    let state = 'ok', text = this.stats.lines ? 'Up to date' : 'Watching';
    if (this.paused) { state = 'paused'; text = 'Paused'; }
    else if (this.lastError && Date.now() - this.lastErrorAt < 12000) { state = 'error'; text = this.lastError.short; }
    else if (this.inflight > 0) { state = 'busy'; text = 'Translating'; }
    else if (this.engineStatus.unsettled > 0) { state = 'busy'; text = 'Reading screen'; }
    return { state, text, pair: this.pair(), key: `${this.settings.hotkeys.toggle} pause` };
  }

  /* ---------- regions in, blocks out ---------- */
  onRegions(regions) {
    const fresh = [];
    for (const r of regions) {
      this.regionMeta.set(r.regionId, { w: r.box.w, h: r.box.h, hash: r.hash, box: r.box, cached: [] });
      if (this.regionMeta.size > 60) this.regionMeta.delete(this.regionMeta.keys().next().value);
      const hit = this.skipCache ? null : this.store.findCached(r.box.w, r.box.h, r.hash);
      if (hit) {
        // Skip lines already painted and still valid at this spot.
        const todo = hit.blocks.filter((b) => !this.isShowing(b, r.box));
        this.stats.cacheHits += todo.length;
        if (!todo.length) continue;
        const list = todo.map((b, i) => {
          const key = `c${r.regionId}:${i}`;
          const text = this.store.recall(b.source) || b.text;
          this.pending.set(key, { ...b, text, fromCache: true, ms: 0 });
          return { key, rel: b.rel, lines: b.lines, kind: b.kind, ext: letterExtent(b.source) };
        });
        this.engine('engine:register', { regionId: r.regionId, blocks: list });
      } else {
        fresh.push(r);
      }
    }
    this.skipCache = false;
    if (fresh.length) this.translate(fresh);
    this.pushStatus();
  }

  isShowing(b, regionBox) {
    const x = regionBox.x + b.rel[0] * regionBox.w, y = regionBox.y + b.rel[1] * regionBox.h;
    const w = (b.rel[2] - b.rel[0]) * regionBox.w, h = (b.rel[3] - b.rel[1]) * regionBox.h;
    for (const d of this.shown.values()) {
      if (!d.visible || d.source !== b.source) continue;
      const ix = Math.max(0, Math.min(x + w, d.box.x + d.box.w) - Math.max(x, d.box.x));
      const iy = Math.max(0, Math.min(y + h, d.box.y + d.box.h) - Math.max(y, d.box.y));
      if (ix * iy > 0.6 * Math.min(w * h, d.box.w * d.box.h)) return true;
    }
    return false;
  }

  recent() {
    const n = this.settings.translate.context_lines;
    return this.transcript.filter((l) => l.kind === 'dialogue' || l.kind === 'choice').slice(-n);
  }

  modelChain() {
    const s = this.settings.models;
    const chain = [s.translate, ...(s.translate_fallbacks || ['gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-flash-lite-latest'])];
    const now = Date.now();
    const ready = [...new Set(chain)].filter((m) => (this.cooldown.get(m) || 0) < now);
    return ready.length ? ready : [s.translate];
  }

  bodyFor(model, regions) {
    const body = translateBody({
      settings: this.settings, profile: this.profile, recent: this.recent(),
      regions: regions.map((r, i) => ({ index: i + 1, width: r.width, height: r.height, mime: r.mime, data: r.data })),
    });
    const gc = body.generationConfig;
    if (this.noThinking.has(model)) delete gc.thinkingConfig;
    else if (/^gemini-2\.5-flash/.test(model)) gc.thinkingConfig = { thinkingBudget: 0 };
    else if (/^gemini-2/.test(model)) delete gc.thinkingConfig;
    return body;
  }

  async translate(regions) {
    if (this.inflight >= MAX_INFLIGHT) {
      // Too many requests open: retry these regions shortly instead of queueing stale work.
      setTimeout(() => regions.forEach((r) => this.engine('engine:uncommit', { box: r.box })), 600);
      return;
    }
    const callId = ++this.callSeq;
    this.inflight++;
    this.stats.calls++;
    this.pushStatus();
    const t0 = Date.now();
    let firstBlockMs = null, emitted = 0;
    const byRegion = new Map();
    const flushRegion = (regionIdx, items) => {
      const r = regions[regionIdx - 1];
      if (!r || !items.length) return;
      this.engine('engine:register', { regionId: r.regionId, blocks: items });
    };

    let lastErr = null;
    for (const model of this.modelChain()) {
      emitted = 0;
      const bs = new BlockStream((key, obj) => {
        if (key === 'blocks') {
          const ri = obj.region || 1;
          const b = this.normalizeBlock(obj);
          if (!b) return;
          if (firstBlockMs === null) firstBlockMs = Date.now() - t0;
          const k = `m${callId}:${emitted++}`;
          this.pending.set(k, { ...b, ms: Date.now() - t0, model });
          if (!byRegion.has(ri)) byRegion.set(ri, 0);
          flushRegion(ri, [{ key: k, rel: b.rel, lines: b.lines, kind: b.kind, ext: letterExtent(b.source) }]);
        } else if (key === 'new_terms') {
          this.learnTerm(obj);
        }
      });
      try {
        const res = await gemini.stream({
          key: getKey(), model, body: this.bodyFor(model, regions), timeoutMs: 15000,
          onText: (t) => bs.push(t),
        });
        if (emitted === 0 && bs.emitted === 0) {
          // Nothing parsed while streaming: try the whole reply once.
          const whole = parseLooseJson(res.text);
          for (const obj of (whole && whole.blocks) || []) {
            const b = this.normalizeBlock(obj);
            if (!b) continue;
            const k = `m${callId}:${emitted++}`;
            this.pending.set(k, { ...b, ms: Date.now() - t0, model });
            byRegion.set(obj.region || 1, 0);
            flushRegion(obj.region || 1, [{ key: k, rel: b.rel, lines: b.lines, kind: b.kind, ext: letterExtent(b.source) }]);
          }
          for (const t of (whole && whole.new_terms) || []) this.learnTerm(t);
        }
        const u = res.usage || {};
        this.stats.tokens.prompt += u.promptTokenCount || 0;
        this.stats.tokens.cached += u.cachedContentTokenCount || 0;
        this.stats.tokens.output += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
        // Regions with nothing to translate are remembered so they are not sent again.
        const withBlocks = new Set([...byRegion.keys()]);
        regions.forEach((r, i) => { if (!withBlocks.has(i + 1)) this.store.putCached(r.box.w, r.box.h, r.hash, []); });
        this.stats.latencies.push(res.ms);
        if (firstBlockMs !== null) this.stats.firstBlock.push(firstBlockMs);
        if (this.stats.latencies.length > 200) this.stats.latencies.shift();
        if (this.stats.firstBlock.length > 200) this.stats.firstBlock.shift();
        this.stats.last = { model, ms: res.ms, firstBlockMs, regions: regions.length, blocks: emitted, prompt: u.promptTokenCount || 0, cached: u.cachedContentTokenCount || 0, output: u.candidatesTokenCount || 0 };
        this.failures = 0;
        this.lastError = null;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (e.status === 400 && /thinking/i.test(e.message) && !this.noThinking.has(model)) {
          this.noThinking.add(model);
          try {
            // Same model once more without thinking settings.
            const res = await gemini.stream({ key: getKey(), model, body: this.bodyFor(model, regions), timeoutMs: 15000, onText: (t) => bs.push(t) });
            void res; lastErr = null; this.failures = 0; this.lastError = null; break;
          } catch (e2) { lastErr = e2; }
        }
        if (lastErr && (lastErr.retryable || lastErr.status === 404)) { this.cooldown.set(model, Date.now() + COOLDOWN_MS); continue; }
        break;
      }
    }
    this.inflight--;
    if (lastErr) {
      this.failures++;
      this.lastError = { short: lastErr.status === 429 ? 'Rate limited' : lastErr.status >= 500 || lastErr.status === 0 ? 'Gemini busy, retrying' : 'Translation failed', message: lastErr.message };
      this.lastErrorAt = Date.now();
      this.ui('session:error', this.lastError);
      const delay = Math.min(30000, 3000 * 2 ** Math.min(4, this.failures - 1));
      setTimeout(() => regions.forEach((r) => this.engine('engine:uncommit', { box: r.box })), delay);
    }
    this.pushStatus();
  }

  normalizeBlock(o) {
    const b = o.box_2d;
    if (!Array.isArray(b) || b.length !== 4 || !o.text) return null;
    let [y0, x0, y1, x1] = b.map((v) => Math.max(0, Math.min(1000, Number(v) || 0)) / 1000);
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    if (x1 - x0 < 0.003 || y1 - y0 < 0.003) return null;
    // The same text always gets the same translation: the player's edit, else the first one seen.
    const source = String(o.source || '');
    const text = this.store.recall(source) || o.text;
    this.store.remember(source, String(o.text));
    return {
      rel: [x0, y0, x1, y1], kind: o.kind || 'other', lines: Math.max(1, Math.min(12, o.lines || 1)),
      align: ['left', 'center', 'right'].includes(o.align) ? o.align : (o.kind === 'choice' ? 'center' : 'left'),
      source: String(o.source || ''), text: String(text), speaker: o.speaker || null,
      confidence: o.confidence || 'high', note: o.note || null, edited: !!this.store.edits[o.source],
    };
  }

  // Engine replies with refined, styled blocks.
  onEngineBlocks({ regionId, blocks }) {
    const paint = [];
    const meta = this.regionMeta.get(regionId);
    for (const e of blocks) {
      if (e.removed) { this.shown.delete(e.id); paint.push({ id: e.id, removed: true }); continue; }
      const d = this.pending.get(e.key);
      if (!d) continue;
      this.pending.delete(e.key);
      const data = { ...d, id: e.id, box: e.box, style: e.style, visible: e.visible, lang: this.settings.languages.target };
      this.shown.set(e.id, data);
      paint.push({ id: e.id, box: e.box, style: e.style, visible: e.visible, text: data.text, kind: data.kind, lang: data.lang, align: data.align || 'left', lines: e.lines || data.lines || 1, maxW: e.maxW });
      if (!d.fromCache) this.stats.lines++;
      this.record(data);
      if (meta && !d.fromCache) {
        meta.cached.push({ rel: e.relRefined, kind: d.kind, lines: d.lines, align: d.align, source: d.source, text: d.text, speaker: d.speaker });
        this.store.putCached(meta.w, meta.h, meta.hash, meta.cached);
      }
    }
    if (paint.length) this.overlay('overlay:paint', paint);
    if (this.shown.size > 500) {
      const drop = [...this.shown.keys()].slice(0, this.shown.size - 400);
      drop.forEach((id) => this.shown.delete(id));
    }
    this.pushStatus();
  }

  onVisibility(list) {
    for (const v of list) { const d = this.shown.get(v.id); if (d) d.visible = v.visible; }
    this.overlay('overlay:visibility', list);
  }

  record(d) {
    if (!d.source || d.kind === 'other') return;
    const recentSame = this.transcript.slice(-10).some((l) => l.source === d.source);
    if (recentSame) return;
    const line = {
      id: ++this.lineSeq, t: Date.now(), kind: d.kind, speaker: d.speaker, source: d.source, text: d.text,
      confidence: d.confidence, note: d.note, ms: d.ms, fromCache: !!d.fromCache, model: d.model || null,
    };
    this.transcript.push(line);
    if (this.transcript.length > 600) this.transcript.splice(0, 100);
    this.store.appendTranscript(line);
    this.ui('session:line', line);
    if (d.kind === 'dialogue' || d.kind === 'choice') this.linesSinceUpdate++;
    if (d.speaker && this.profile && !(this.profile.characters || []).some((c) => c.source === d.speaker)) this.newSpeakers.add(d.speaker);
    this.maybeIdentify();
    this.maybeUpdateProfile();
  }

  learnTerm(t) {
    if (!t || !t.source || !t.target) return;
    const known = (this.profile?.glossary || []).some((g) => g.source === t.source) || this.pendingTerms.some((p) => p.source === t.source);
    if (known) return;
    const term = { source: t.source, target: t.target, kind: t.kind || 'other', keep: false, note: '', origin: 'game', reviewed: false };
    this.pendingTerms.push(term);
    if (this.profile) {
      this.profile.glossary = [...(this.profile.glossary || []), term];
      this.store.saveProfile(this.profile);
      this.ui('profile:changed', this.profile);
    }
    this.ui('session:terms', this.pendingTerms);
  }

  /* ---------- profile: first-play draft and background updates ---------- */
  maybeIdentify() {
    if (this.profileStatus !== 'waiting') return;
    const n = this.transcript.filter((l) => l.t >= this.startedAt).length;
    if (n >= this.settings.profile.identify_after_text_lines) this.identify();
  }

  async identify() {
    if (this.profileStatus === 'drafting') return;
    clearTimeout(this.identifyTimer);
    this.profileStatus = 'drafting';
    this.ui('profile:status', { status: 'drafting' });
    try {
      const shot = await this.snapshot().catch(() => null);
      const info = { title: this.game.title, exeName: this.game.exe, version: exeVersionInfo(this.game.exePath || '') };
      const screenText = this.transcript.filter((l) => l.t >= this.startedAt).slice(0, 20).map((l) => l.source);
      const body = identifyBody({ settings: this.settings, info, screenText, screenshot: shot });
      let res = null, lastErr = null;
      for (const model of [...new Set([this.settings.models.profile, 'gemini-3.1-pro-preview', this.settings.models.translate, 'gemini-2.5-flash'])]) {
        try { res = await gemini.generate({ key: getKey(), model, body, timeoutMs: 150000 }); res.model = model; break; } catch (e) { lastErr = e; if (!e.retryable && e.status !== 404) break; }
      }
      if (!res) throw lastErr || new Error('No reply');
      const p = parseLooseJson(res.text);
      if (!p) throw new Error('The profile reply was not valid JSON.');
      const sources = new Set(p.sources || []);
      for (const c of res.grounding?.groundingChunks || []) if (c.web?.uri) sources.add(c.web.uri);
      const old = this.profile || {};
      const profile = {
        auto: true, identified: p.identified !== false, confidence: p.confidence || 'medium',
        titles: p.titles || {}, genre: p.genre || '', tone: p.tone || '', setting: p.setting || '',
        characters: (p.characters || []).map((c) => ({ ...c, origin: 'search', locked: false })),
        glossary: [...(p.glossary || []).map((g) => ({ ...g, origin: 'search', locked: false })), ...((old.glossary || []).filter((g) => g.origin !== 'search'))],
        style_rules: p.style_rules || [], style_examples: old.style_examples || [],
        sources: [...sources].slice(0, 12), drafted_at: new Date().toISOString(), drafted_by: res.model,
      };
      // Keep anything the player edited in an earlier draft.
      for (const c of old.characters || []) if (c.locked) { const i = profile.characters.findIndex((x) => x.source === c.source); if (i >= 0) profile.characters[i] = c; else profile.characters.push(c); }
      for (const g of old.glossary || []) if (g.locked) { const i = profile.glossary.findIndex((x) => x.source === g.source); if (i >= 0) profile.glossary[i] = g; else profile.glossary.push(g); }
      // Terms the translator learned before the draft existed.
      for (const t of this.pendingTerms) if (!profile.glossary.some((x) => x.source === t.source)) profile.glossary.push(t);
      this.profile = this.store.saveProfile(profile);
      this.profileStatus = 'ready';
      this.ui('profile:changed', this.profile);
      this.ui('profile:status', { status: 'ready' });
    } catch (e) {
      this.profileStatus = 'failed';
      this.ui('profile:status', { status: 'failed', message: e.message });
    }
  }

  maybeUpdateProfile() {
    const s = this.settings.profile;
    if (!this.profile || this.updating || this.profileStatus === 'drafting') return;
    if (Date.now() - this.lastUpdateAt < s.update_min_interval_s * 1000) return;
    const speakerTrigger = s.update_on_new_speaker && this.newSpeakers.size > 0;
    if (!speakerTrigger && this.linesSinceUpdate < s.update_every_lines) return;
    this.updateProfile();
  }

  async updateProfile() {
    this.updating = true;
    this.lastUpdateAt = Date.now();
    const speakers = [...this.newSpeakers];
    try {
      const body = updateBody({
        settings: this.settings, profile: this.profile,
        transcript: this.transcript.slice(-this.settings.profile.transcript_lines_per_update),
        pendingTerms: this.pendingTerms.filter((t) => !t.reviewed), newSpeakers: speakers,
      });
      let res = null;
      for (const model of [...new Set([this.settings.models.profile, this.settings.models.translate, 'gemini-2.5-flash'])]) {
        try { res = await gemini.generate({ key: getKey(), model, body, timeoutMs: 120000 }); break; } catch (e) { if (!e.retryable && e.status !== 404) throw e; }
      }
      const patch = res && parseLooseJson(res.text);
      if (patch) this.applyPatch(patch);
      speakers.forEach((n) => this.newSpeakers.delete(n));
      this.linesSinceUpdate = 0;
    } catch (e) {
      this.ui('session:error', { short: 'Profile update failed', message: e.message });
    } finally { this.updating = false; }
  }

  applyPatch(p) {
    const prof = this.profile;
    prof.characters = prof.characters || [];
    prof.glossary = prof.glossary || [];
    for (const c of p.add_characters || []) if (c.source && !prof.characters.some((x) => x.source === c.source)) prof.characters.push({ ...c, origin: 'game', locked: false });
    for (const u of p.update_characters || []) {
      const c = prof.characters.find((x) => x.source === u.source);
      if (c && !c.locked && ['target', 'role', 'speech', 'gender'].includes(u.field)) c[u.field] = u.value;
    }
    for (const t of p.add_terms || []) if (t.source && !prof.glossary.some((x) => x.source === t.source)) prof.glossary.push({ ...t, origin: 'game', locked: false });
    if ((p.conflicts || []).length) { this.conflicts.push(...p.conflicts); this.ui('session:conflicts', this.conflicts); }
    this.store.saveProfile(prof);
    this.ui('profile:changed', prof);
  }

  /* ---------- player actions ---------- */
  editLine(id, text, asExample) {
    const line = this.transcript.find((l) => l.id === id);
    if (!line) return;
    line.was = line.was || line.text;
    line.text = text; line.edited = true;
    this.store.saveEdit(line.source, text);
    this.store.updateCachedText(line.source, text);
    this.store.appendTranscript({ type: 'edit', id, text, t: Date.now() });
    const paint = [];
    for (const [bid, d] of this.shown) if (d.source === line.source) { d.text = text; paint.push({ id: bid, text }); }
    if (paint.length) this.overlay('overlay:paint', paint);
    if (asExample && this.profile) {
      this.profile.style_examples = [...(this.profile.style_examples || []), { speaker: line.speaker, source: line.source, text }];
      this.store.saveProfile(this.profile);
      this.ui('profile:changed', this.profile);
    }
    this.ui('session:line-updated', line);
  }

  reviewTerm(source, target) {
    const t = this.pendingTerms.find((p) => p.source === source);
    if (t) { t.reviewed = true; if (target) t.target = target; }
    if (this.profile) {
      const g = (this.profile.glossary || []).find((x) => x.source === source);
      if (g) { g.reviewed = true; if (target) { g.target = target; g.locked = true; g.origin = 'user'; } }
      this.store.saveProfile(this.profile);
      this.ui('profile:changed', this.profile);
    }
    this.ui('session:terms', this.pendingTerms);
  }

  setProfile(p) { this.profile = p; }

  retranslate() { this.skipCache = true; }

  statusPayload() {
    return {
      game: this.game, paused: this.paused, hud: this.hud(), profileStatus: this.profileStatus,
      stats: {
        lines: this.stats.lines, cacheHits: this.stats.cacheHits, calls: this.stats.calls,
        medianMs: median(this.stats.latencies), medianFirstMs: median(this.stats.firstBlock),
        tokens: this.stats.tokens, last: this.stats.last, minutes: Math.round((Date.now() - this.startedAt) / 60000),
        cacheShare: this.stats.lines + this.stats.cacheHits ? this.stats.cacheHits / (this.stats.lines + this.stats.cacheHits) : 0,
      },
      engine: this.engineStatus, inflight: this.inflight, error: this.lastError,
    };
  }

  pushStatus() {
    this.overlay('overlay:hud', this.hud());
    this.ui('session:status', this.statusPayload());
  }

  reloadSettings() { this.settings = loadSettings(); }
}

module.exports = { Session };
