'use strict';
/* Control panel: Games, Game profile, Live session, Settings. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const main = $('#main');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  page: 'games', settings: null, key: null, session: null, game: null, languages: {},
  windows: [], library: [], gameId: null, profileData: null, profileDirty: false,
  transcript: [], terms: [], conflicts: [], editingLine: null, models: [], profileStatus: null, lastError: null,
};

async function call(ch, arg) {
  const r = await api.invoke(ch, arg);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
let toastTimer = null;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 2600);
}
async function act(fn, okMsg) {
  try { const v = await fn(); if (okMsg) toast(okMsg); return v; } catch (e) { toast(e.message, true); return undefined; }
}
const kbd = (k) => (k ? k.split('+').map((x) => `<kbd>${esc(x)}</kbd>`).join(' + ') : '');
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDate = (s) => { if (!s) return 'Never'; const d = new Date(s); const today = new Date(); return d.toDateString() === today.toDateString() ? `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : d.toLocaleDateString(); };
const num = (n) => (n || 0).toLocaleString();
const secs = (ms) => (ms ? `${(ms / 1000).toFixed(2)} s` : '—');
const running = () => !!(S.session && S.game);

/* ---------- navigation ---------- */
function go(page) {
  S.page = page;
  $$('.side a[data-page]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.page === page));
  if (page !== 'profile') S.profileDirty = false;
  render();
}
$$('.side a[data-page]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.page); }));

function render() {
  const pages = { games: renderGames, profile: renderProfile, session: renderSession, settings: renderSettings };
  (pages[S.page] || renderGames)();
  renderRunstate();
}

function renderRunstate() {
  const el = $('#runstate');
  const s = S.settings;
  if (!s) return;
  if (running()) {
    const h = S.session.hud || {};
    const cls = S.session.paused ? '' : h.state === 'error' ? 'bad' : 'ok';
    el.innerHTML = `<span class="chip ${cls}"><span class="dot"></span>${S.session.paused ? 'Paused' : 'Overlay running'}</span>
      <span><b class="jp">${esc(S.game.title)}</b></span>
      <span>${esc(h.text || '')}</span>
      <span>${kbd(s.hotkeys.toggle)} pause · ${kbd(s.display.peek_key)} original</span>`;
  } else {
    el.innerHTML = `<span class="chip"><span class="dot"></span>Overlay off</span><span>${esc(s.models.translate)}</span><span>Press ${kbd(s.hotkeys.toggle)} in a game to start</span>`;
  }
}

/* ---------- Games ---------- */
async function loadGames() {
  const [wins, lib] = await Promise.all([call('windows:list').catch(() => []), call('library:list').catch(() => [])]);
  S.windows = wins; S.library = lib;
}

function modeChip(mode) {
  if (mode === 'borderless') return '<span class="chip ok"><span class="dot"></span>Borderless window</span>';
  if (mode === 'maximized') return '<span class="chip ok"><span class="dot"></span>Maximized window</span>';
  return '<span class="chip ok"><span class="dot"></span>Windowed</span>';
}

function renderGames() {
  const s = S.settings;
  const cur = running() ? S.windows.find((w) => w.hwnd === S.game.hwnd) : null;
  const others = S.windows.filter((w) => !running() || w.hwnd !== S.game.hwnd);
  const keyWarn = S.key && !S.key.saved ? `<div class="banner bad"><div><b>No Gemini key saved.</b><small>Add one in Settings before starting the overlay.</small></div><button class="btn" data-go="settings">Open Settings</button></div>` : '';
  main.innerHTML = `
    <div class="pagehead"><div><h1>Games</h1><p>Pick the game window to translate. Each game keeps its own profile, glossary and translation memory.</p></div>
      <div class="actions"><button class="btn" id="refresh">Refresh windows</button></div></div>
    ${keyWarn}
    ${running() ? `
    <div class="box running">
      <div class="thumb">${cur && cur.thumb ? `<img src="${cur.thumb}" alt="">` : ''}</div>
      <div>
        <div class="eyebrow"><span class="dot"></span>${S.session.paused ? 'Paused' : 'Translating now'}</div>
        <h3><span class="jp">${esc(S.game.title)}</span></h3>
        <div class="subline">${esc(S.game.exe)} · ${esc(S.session.hud?.pair || '')}</div>
        <div class="checks">
          ${cur ? modeChip(cur.mode) : ''}
          <span class="chip ok"><span class="dot"></span>Overlay hidden from capture</span>
          <span class="chip sub">${num(S.session.stats.lines + S.session.stats.cacheHits)} lines shown this session</span>
        </div>
      </div>
      <div class="col-actions">
        <button class="btn primary" id="pause">${S.session.paused ? 'Resume' : 'Pause'} ${kbd(s.hotkeys.toggle)}</button>
        <button class="btn" id="retrans">Translate screen again ${kbd(s.hotkeys.retranslate)}</button>
        <button class="btn" id="zones">Ignore or read areas ${kbd(s.hotkeys.zones)}</button>
        <button class="btn ghost" id="stop">Stop overlay</button>
      </div>
    </div>` : ''}
    <section class="section">
      <div class="section-head"><h2>Open windows</h2><span class="hint">Run games in borderless or windowed mode. Nothing can draw over exclusive fullscreen.</span></div>
      ${others.length ? `<div class="wins">${others.map((w) => `
        <div class="win">
          <div class="thumb">${w.thumb ? `<img src="${w.thumb}" alt="">` : ''}</div>
          <div><b class="jp" title="${esc(w.title)}">${esc(w.title)}</b><small>${esc(w.exe)} · ${w.bounds.width} × ${w.bounds.height}</small></div>
          <div class="row">${w.known ? '<span class="chip sub">In library</span>' : '<span class="chip">New game</span>'}<button class="btn sm primary" data-start="${esc(w.sourceId)}">Start overlay</button></div>
        </div>`).join('')}</div>` : '<div class="box empty"><b>No game windows found</b>Start your game, then press Refresh windows.</div>'}
    </section>
    <section class="section">
      <div class="section-head"><h2>Library</h2><span class="hint">Sorted by last played</span></div>
      ${S.library.length ? `<div class="box scroll-x"><table class="t">
        <thead><tr><th>Game</th><th>Profile</th><th class="r">Lines remembered</th><th>Last played</th><th></th></tr></thead>
        <tbody>${S.library.map((g) => `<tr>
          <td><div class="gname"><b class="jp">${esc(g.title || g.id)}</b><span>${esc(g.exe || '')}</span></div></td>
          <td>${g.profile ? (g.profile.identified ? `<span class="chip ok">${g.profile.auto ? 'Drafted' : 'Written'} · ${g.profile.characters} characters, ${g.profile.terms} terms</span>` : '<span class="chip warn">Game not identified</span>') : '<span class="chip info">Drafts on first play</span>'}</td>
          <td class="r num">${num(g.lines_cached)}</td><td>${esc(fmtDate(g.last_played))}</td>
          <td><button class="btn sm" data-profile="${esc(g.id)}">Profile</button> <button class="btn sm ghost" data-log="${esc(g.id)}">Transcript</button></td></tr>`).join('')}</tbody></table></div>`
        : '<div class="box empty"><b>No games yet</b>Games appear here after you start the overlay on them.</div>'}
    </section>
    <section class="section"><h2>In-game keys</h2>
      <div class="hk"><span>${kbd(s.hotkeys.toggle)} Start or pause</span><span>${kbd(s.display.peek_key)} hold to see the original</span><span>${kbd(s.hotkeys.retranslate)} Translate this screen again</span><span>${kbd(s.hotkeys.show_log)} Open the session log</span><span>${kbd(s.hotkeys.zones)} Ignore or read areas</span></div>
    </section>`;
  $('#refresh').onclick = async () => { await loadGames(); renderGames(); };
  $$('[data-start]').forEach((b) => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Starting';
    const g = await act(() => call('overlay:start', { sourceId: b.dataset.start }));
    if (g) { S.game = g; S.gameId = g.id; toast('Overlay started. Switch to the game.'); }
    await loadGames(); renderGames();
  });
  $$('[data-profile]').forEach((b) => b.onclick = () => { S.gameId = b.dataset.profile; S.profileData = null; go('profile'); });
  $$('[data-log]').forEach((b) => b.onclick = () => { S.gameId = b.dataset.log; S.transcript = null; go('session'); });
  $$('[data-go]').forEach((b) => b.onclick = () => go(b.dataset.go));
  if (running()) {
    $('#pause').onclick = () => act(() => call('overlay:pause'));
    $('#retrans').onclick = () => act(() => call('overlay:retranslate'), 'Translating the screen again');
    $('#zones').onclick = () => act(() => call('zones:edit'), 'Draw areas on the game screen');
    $('#stop').onclick = () => act(() => call('overlay:stop'));
  }
}

/* ---------- Profile ---------- */
function profileGameId() { return S.gameId || (S.game && S.game.id) || (S.library[0] && S.library[0].id) || null; }

async function loadProfile() {
  const id = profileGameId();
  if (!id) { S.profileData = null; return; }
  S.profileData = await call('profile:get', { gameId: id });
  S.profileData.id = id;
}

const emptyProfile = () => ({ titles: {}, genre: '', tone: '', setting: '', characters: [], glossary: [], style_rules: [], style_examples: [] });

function estTokens(text) { const s = String(text || ''); const cjk = (s.match(/[　-鿿가-힯]/g) || []).length; return Math.round(cjk * 0.9 + (s.length - cjk) / 3.6); }

function renderProfile() {
  const id = profileGameId();
  if (!id) { main.innerHTML = `<div class="pagehead"><div><h1>Game profile</h1><p>Start the overlay on a game first. Its profile is drafted automatically the first time you play it.</p></div></div>`; return; }
  if (!S.profileData || S.profileData.id !== id) { main.innerHTML = '<div class="empty">Loading</div>'; loadProfile().then(renderProfile).catch((e) => toast(e.message, true)); return; }
  const d = S.profileData;
  const p = d.profile || emptyProfile();
  const isCurrent = running() && S.game.id === id;
  const status = isCurrent ? (S.profileStatus || S.session.profileStatus) : null;
  let draft = '';
  if (status === 'drafting') draft = `<div class="box draft"><div><div class="eyebrow">Drafting now</div><p>Searching the web for this game's cast and terms, using its title screen. This usually takes under a minute. Translation carries on meanwhile.</p></div></div>`;
  else if (status === 'waiting') draft = `<div class="box draft"><div><div class="eyebrow">Draft starts soon</div><p>The profile is drafted after the first few lines of text, so the model can see the title screen and opening.</p></div><div class="actions"><button class="btn" id="draft">Draft now</button></div></div>`;
  else if (status === 'failed') draft = `<div class="banner bad"><div><b>The draft failed.</b><small>${esc(S.lastError?.message || 'Try again in a moment.')}</small></div><button class="btn" id="draft">Draft again</button></div>`;
  else if (d.profile && d.profile.auto) {
    const srcs = (p.sources || []).map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(Boolean);
    const uniq = [...new Set(srcs)].slice(0, 5);
    draft = `<div class="box draft"><div><div class="eyebrow">${p.identified === false ? 'Game not identified' : 'Drafted automatically'}</div>
      <p>${p.identified === false ? 'The search could not identify this game, so the profile only holds what the screen showed. Fill in the story and cast for better names and tone.' : `Written ${esc(fmtDate(p.drafted_at))} from a web search on the title screen and the game's executable. Updated in the background as new characters speak. Anything you edit is locked and never changed again.`}</p>
      <div class="src">${uniq.map((h) => `<span class="chip info">${esc(h)}</span>`).join('')}</div></div>
      <div class="actions">${isCurrent ? '<button class="btn ghost" id="draft">Draft again</button>' : ''}</div></div>`;
  } else if (!d.profile) {
    draft = `<div class="box draft"><div><div class="eyebrow">No profile yet</div><p>${isCurrent ? 'The draft starts after the first few lines of text.' : 'Start the overlay on this game and the profile is drafted automatically.'} You can also write it by hand below.</p></div>${isCurrent ? '<div class="actions"><button class="btn" id="draft">Draft now</button></div>' : ''}</div>`;
  }
  const t = p.titles || {};
  const charRows = (p.characters || []).map((c, i) => `<tr data-i="${i}">
    <td><input class="input jp" data-f="source" value="${esc(c.source)}"></td>
    <td><input class="input" data-f="reading" value="${esc(c.reading)}"></td>
    <td><input class="input cjk" data-f="target" value="${esc(c.target)}"></td>
    <td><input class="input" data-f="role" value="${esc(c.role)}"></td>
    <td><input class="input" data-f="speech" value="${esc(c.speech)}"></td>
    <td class="x">${c.locked ? '<span class="lock" title="Edited by you, never changed automatically">●</span>' : ''}<button class="icon-btn" data-del="char" title="Remove">×</button></td></tr>`).join('');
  const termRows = (p.glossary || []).map((g, i) => `<tr data-i="${i}">
    <td><input class="input jp" data-f="source" value="${esc(g.source)}"></td>
    <td><input class="input cjk" data-f="target" value="${esc(g.target)}"></td>
    <td style="text-align:center"><input type="checkbox" data-f="keep" ${g.keep ? 'checked' : ''} title="Keep untranslated"></td>
    <td><input class="input" data-f="note" value="${esc(g.note)}"></td>
    <td>${g.locked || g.origin === 'user' ? '<span class="chip sub">You set</span>' : g.origin === 'search' ? '<span class="chip info">Web search</span>' : '<span class="chip">Seen in game</span>'}</td>
    <td class="x"><button class="icon-btn" data-del="term" title="Remove">×</button></td></tr>`).join('');

  const settings = S.settings;
  const layers = [
    ['Translation rules', 'Fixed by the app. Output JSON only.', '≈ 1,000', true],
    ['This profile', 'Story, characters, style rules', `≈ ${num(estTokens(JSON.stringify([p.setting, p.tone, p.characters, p.style_rules, p.style_examples])))}`, true],
    ['Glossary', `${(p.glossary || []).length} terms`, `≈ ${num(estTokens(JSON.stringify(p.glossary || [])))}`, true],
    ['Recent dialogue', `Last ${settings.translate.context_lines} lines with speakers`, 'varies', false],
    ['Changed parts of the screen', 'Cropped images, only where text changed', '≈ 300–1,200', false],
  ];
  const last = isCurrent && S.session.stats.last;
  main.innerHTML = `
    <div class="pagehead"><div><h1><span class="jp">${esc(d.meta.title || id)}</span> profile</h1><p>Background the model reads before every line. It stays cached, so it adds almost nothing to each request.</p></div>
      <div class="actions"><button class="btn primary" id="save">Save profile</button></div></div>
    ${draft}
    <div class="cols">
      <div class="form">
        <section class="section"><h2>Basics</h2>
          <div class="row3">
            <div class="field"><label for="t-orig">Original title</label><input class="input jp" id="t-orig" value="${esc(t.original)}"></div>
            <div class="field"><label for="t-rom">Romanized</label><input class="input" id="t-rom" value="${esc(t.romanized)}"></div>
            <div class="field"><label for="t-tgt">Official translated title</label><input class="input cjk" id="t-tgt" value="${esc(t.target)}"></div>
          </div>
          <div class="field"><label for="genre">Genre</label><input class="input" id="genre" value="${esc(p.genre)}"></div>
          <div class="field"><label for="tone">Tone</label><input class="input" id="tone" value="${esc(p.tone)}"></div>
          <div class="field"><label for="setting">Story so far</label><textarea class="input" id="setting" rows="4">${esc(p.setting)}</textarea><span class="hint">No spoilers needed. A paragraph about the setting and the cast is enough.</span></div>
        </section>
        <section class="section"><div class="section-head"><h2>Characters</h2><button class="btn sm" id="add-char">Add character</button></div>
          <div class="box scroll-x"><table class="t edit wide" id="chars"><thead><tr><th>In game</th><th>Reading</th><th>Written as</th><th>Who</th><th>How they speak</th><th></th></tr></thead><tbody>${charRows || '<tr><td colspan="6" class="empty">No characters yet</td></tr>'}</tbody></table></div>
        </section>
        <section class="section"><div class="section-head"><h2>Glossary</h2><button class="btn sm" id="add-term">Add term</button></div>
          <div class="box scroll-x"><table class="t edit" id="terms"><thead><tr><th>In game</th><th>Always write</th><th>Keep</th><th>Note</th><th>Source</th><th></th></tr></thead><tbody>${termRows || '<tr><td colspan="6" class="empty">No terms yet</td></tr>'}</tbody></table></div>
        </section>
        <section class="section"><h2>Style rules</h2>
          <div class="field"><textarea class="input" id="rules" rows="4" placeholder="One rule per line">${esc((p.style_rules || []).join('\n'))}</textarea><span class="hint">One rule per line, for example how to handle honorifics.</span></div>
        </section>
      </div>
      <aside class="req">
        <div class="section-head"><h2>What the model receives</h2></div>
        <div class="box">
          ${layers.map(([b, sm, tok, cached], i) => `<div class="layer"><span class="n">${i + 1}</span><div><b>${b}</b><small>${sm}</small></div><span class="tok">${tok}${cached ? ' · same every call' : ''}</span></div>`).join('')}
          <div class="total">${last ? `<span>Last request <b>${num(last.prompt)}</b> tokens, <b>${num(last.cached)}</b> cached</span><span>${secs(last.ms)} · ${esc(last.model)}</span>` : '<span>Token counts appear after the first translation.</span>'}</div>
        </div>
        <p class="hint" style="margin:0">The model returns the position of each line it reads. The app then tightens that box onto the actual letters before painting.</p>
      </aside>
    </div>`;

  const markDirty = () => { S.profileDirty = true; };
  main.querySelectorAll('input, textarea').forEach((el) => el.addEventListener('input', markDirty));
  // Edited rows are locked so background updates never overwrite them.
  $$('#chars tbody tr[data-i], #terms tbody tr[data-i]').forEach((tr) => tr.addEventListener('input', () => { tr.dataset.edited = '1'; }));
  $('#save').onclick = saveProfile;
  const dr = $('#draft');
  if (dr) dr.onclick = () => act(() => call('profile:draft', { gameId: id }), 'Drafting the profile');
  $('#add-char').onclick = () => { collectProfile(); S.profileData.profile.characters.push({ source: '', target: '', role: '', speech: '', locked: true, origin: 'user' }); S.profileDirty = true; renderProfile(); };
  $('#add-term').onclick = () => { collectProfile(); S.profileData.profile.glossary.push({ source: '', target: '', keep: false, note: '', locked: true, origin: 'user' }); S.profileDirty = true; renderProfile(); };
  $$('[data-del]').forEach((b) => b.onclick = () => {
    collectProfile();
    const i = Number(b.closest('tr').dataset.i);
    (b.dataset.del === 'char' ? S.profileData.profile.characters : S.profileData.profile.glossary).splice(i, 1);
    S.profileDirty = true; renderProfile();
  });
}

function collectProfile() {
  const d = S.profileData;
  const p = d.profile ? { ...d.profile } : emptyProfile();
  const v = (id) => ($('#' + id) ? $('#' + id).value.trim() : '');
  p.titles = { ...(p.titles || {}), original: v('t-orig'), romanized: v('t-rom'), target: v('t-tgt') };
  p.genre = v('genre'); p.tone = v('tone'); p.setting = v('setting');
  p.style_rules = v('rules').split('\n').map((x) => x.trim()).filter(Boolean);
  const rows = (sel, list) => $$(sel + ' tbody tr[data-i]').map((tr) => {
    const o = { ...(list[Number(tr.dataset.i)] || {}) };
    tr.querySelectorAll('[data-f]').forEach((el) => { o[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
    if (tr.dataset.edited) { o.locked = true; if (o.origin !== 'user') o.origin = o.origin || 'user'; }
    return o;
  }).filter((o) => o.source);
  p.characters = rows('#chars', p.characters || []);
  p.glossary = rows('#terms', p.glossary || []);
  d.profile = p;
  return p;
}

async function saveProfile() {
  const p = collectProfile();
  const id = S.profileData.id;
  const saved = await act(() => call('profile:save', { gameId: id, profile: p }), 'Profile saved');
  if (saved) { S.profileData.profile = saved; S.profileDirty = false; renderProfile(); }
}

/* ---------- Session ---------- */
async function loadTranscript() {
  const id = S.gameId && (!running() || S.gameId !== S.game.id) ? S.gameId : undefined;
  const r = await call('session:transcript', id ? { gameId: id } : {});
  S.transcript = r.lines; S.terms = r.terms; S.conflicts = r.conflicts;
}

function entryHtml(l) {
  const who = l.speaker ? esc(l.speaker) : l.kind === 'choice' ? 'Choice' : l.kind === 'menu' || l.kind === 'label' ? 'Menu' : l.kind === 'name' ? 'Name' : 'Narration';
  const chips = [];
  if (l.edited) chips.push('<span class="chip ok">Edited by you</span>');
  else if (l.confidence === 'low') chips.push('<span class="chip warn">Unsure</span>');
  if (l.fromCache) chips.push('<span class="chip ok">Memory</span>');
  const editing = S.editingLine === l.id;
  return `<div class="entry" data-id="${l.id}">
    <span class="time">${fmtTime(l.t)}</span>
    <div><div class="who">${who}</div><div class="src">${esc(l.source)}</div>
      ${l.was && l.edited ? `<div class="was">${esc(l.was)}</div>` : ''}
      ${editing ? '' : `<div class="dst" title="Click to edit">${esc(l.text)}</div>`}</div>
    <div class="meta">${chips.join('')}<span class="mono num subtle">${l.fromCache ? '' : l.ms ? secs(l.ms) : ''}</span></div>
    ${l.note && !l.edited ? `<div class="note"><span>Model note:</span><span class="muted">${esc(l.note)}</span></div>` : ''}
    ${editing ? `<div class="editing"><input class="input" id="edit-text" value="${esc(l.text)}" aria-label="Edit translation">
      <div class="row"><button class="btn sm primary" id="edit-save">Save and repaint</button><button class="btn sm ghost" id="edit-cancel">Cancel</button>
      <label class="toggle" for="edit-example" style="font-size:12.5px"><input type="checkbox" id="edit-example"> Also keep as a style example${l.speaker ? ' for this character' : ''}</label></div></div>` : ''}
  </div>`;
}

function statsHtml() {
  const st = running() ? S.session.stats : null;
  if (!st) return '';
  const total = st.lines + st.cacheHits;
  return `<div class="stats" id="stats">
    <div class="stat"><span>Lines translated</span><b>${num(st.lines)}</b><small>in ${st.minutes} min</small></div>
    <div class="stat"><span>Shown from memory</span><b>${total ? Math.round(st.cacheShare * 100) : 0}%</b><small>menus, names, re-read lines</small></div>
    <div class="stat"><span>Median wait</span><b>${secs(st.medianFirstMs || st.medianMs)}</b><small>request to first translation</small></div>
    <div class="stat"><span>Tokens</span><b>${num(st.tokens.prompt + st.tokens.output)}</b><small>${num(st.tokens.cached)} of input cached</small></div>
  </div>`;
}

function renderSession() {
  if (S.transcript === null || S.transcript === undefined || S._tFor !== (S.gameId || S.game?.id)) {
    S._tFor = S.gameId || S.game?.id;
    main.innerHTML = '<div class="empty">Loading</div>';
    loadTranscript().then(renderSession).catch((e) => toast(e.message, true));
    return;
  }
  const live = running() && (!S.gameId || S.gameId === S.game.id);
  const err = live && S.lastError && Date.now() - S.lastError.at < 30000 ? `<div class="banner bad"><div><b>${esc(S.lastError.short)}</b><small>${esc(S.lastError.message)}</small></div></div>` : '';
  const lines = [...S.transcript].reverse();
  const pending = (S.terms || []).filter((t) => !t.reviewed);
  const eng = live ? S.session.engine || {} : {};
  const last = live ? S.session.stats.last : null;
  main.innerHTML = `
    <div class="pagehead"><div><h1>${live ? 'Live session' : 'Transcript'}</h1><p>${live ? 'Every line translated so far, newest first. Fix a line here and the game screen updates at once.' : 'Lines translated in earlier sessions of this game.'}</p></div>
      <div class="actions">${live ? `<button class="btn" id="pause">${S.session.paused ? 'Resume' : 'Pause'} ${kbd(S.settings.hotkeys.toggle)}</button>` : ''}<button class="btn" id="export">Export transcript</button></div></div>
    ${err}
    ${live ? statsHtml() : ''}
    <div class="scols">
      <section class="section"><div class="section-head"><h2>Transcript</h2>${live ? '<span class="hint">Click a translation to edit it</span>' : ''}</div>
        <div class="box log" id="log">${lines.length ? lines.map(entryHtml).join('') : '<div class="empty"><b>Nothing yet</b>Lines appear here as the overlay translates them.</div>'}</div>
      </section>
      <div class="side-stack">
        ${live ? `<section class="section"><div class="section-head"><h2>New terms</h2><span class="hint">Found this session</span></div>
          <div class="box terms" id="terms-box">${pending.length ? pending.map((t) => `<div class="term" data-src="${esc(t.source)}"><span><span class="jp">${esc(t.source)}</span> → <span class="cjk">${esc(t.target)}</span></span>
            <span class="actions"><button class="btn sm" data-keep>Keep</button><button class="btn sm ghost" data-change>Change</button></span><small>${esc(t.kind || '')}</small></div>`).join('') : '<div class="empty">No new names or terms waiting.</div>'}</div>
          <p class="hint" style="margin:0">New terms are used for every later line straight away. Keep confirms them; Change locks in your version.</p></section>` : ''}
        ${live && S.conflicts.length ? `<section class="section"><h2>Inconsistent names</h2><div class="box kv">${S.conflicts.slice(-6).map((c) => `<div><span class="jp">${esc(c.source)}</span><span class="cjk">${esc((c.seen || []).join(' / '))} → ${esc(c.use)}</span></div>`).join('')}</div></section>` : ''}
        ${live ? `<section class="section"><h2>Right now</h2><div class="box kv" id="now">
          <div><span>Screen</span><span>${eng.unsettled ? 'Text changing' : 'Settled'} · ${eng.visible ?? 0} lines painted</span></div>
          <div><span>Capture</span><span class="mono num">${eng.fps ?? 0} scans/s</span></div>
          <div><span>Last request</span><span class="mono num">${last ? `${num(last.prompt)} tokens · ${secs(last.ms)}` : '—'}</span></div>
          <div><span>Model</span><span>${esc(last ? last.model : S.settings.models.translate)}</span></div>
          <button class="btn sm" id="again" style="justify-self:start;margin-top:4px">Translate again ${kbd(S.settings.hotkeys.retranslate)}</button>
        </div></section>` : ''}
      </div>
    </div>`;
  bindSession();
}

function bindSession() {
  const p = $('#pause'); if (p) p.onclick = () => act(() => call('overlay:pause'));
  $('#export').onclick = () => act(async () => { const f = await call('transcript:export', { gameId: S.gameId || S.game?.id }); if (f) toast('Saved to ' + f); });
  const again = $('#again'); if (again) again.onclick = () => act(() => call('overlay:retranslate'), 'Translating the screen again');
  $$('#log .dst').forEach((el) => el.onclick = () => {
    if (!running()) return;
    S.editingLine = Number(el.closest('.entry').dataset.id); renderSession();
    const inp = $('#edit-text'); inp.focus(); inp.select();
  });
  const save = $('#edit-save');
  if (save) {
    const done = async () => {
      const text = $('#edit-text').value.trim();
      const asExample = $('#edit-example').checked;
      const id = S.editingLine;
      if (text) await act(() => call('session:edit', { id, text, asExample }), 'Saved. The game screen is updated.');
      S.editingLine = null; renderSession();
    };
    save.onclick = done;
    $('#edit-text').onkeydown = (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') { S.editingLine = null; renderSession(); } };
    $('#edit-cancel').onclick = () => { S.editingLine = null; renderSession(); };
  }
  $$('#terms-box .term').forEach((row) => {
    const src = row.dataset.src;
    const keep = row.querySelector('[data-keep]');
    if (keep) keep.onclick = () => act(() => call('terms:review', { source: src }));
    const ch = row.querySelector('[data-change]');
    if (ch) ch.onclick = () => {
      const span = row.querySelector('.cjk');
      const inp = document.createElement('input'); inp.className = 'input cjk'; inp.value = span.textContent; inp.style.width = '140px';
      span.replaceWith(inp); inp.focus();
      ch.textContent = 'Save';
      ch.onclick = () => act(() => call('terms:review', { source: src, target: inp.value.trim() }), 'Term saved to the glossary');
    };
  });
}

function updateSessionLive() {
  if (S.page !== 'session' || !running()) return;
  const st = $('#stats');
  if (st) st.outerHTML = statsHtml();
  const now = $('#now');
  if (now) {
    const eng = S.session.engine || {}, last = S.session.stats.last;
    const rows = now.querySelectorAll('div > span:last-child');
    if (rows.length >= 4) {
      rows[0].textContent = `${eng.unsettled ? 'Text changing' : 'Settled'} · ${eng.visible ?? 0} lines painted`;
      rows[1].textContent = `${eng.fps ?? 0} scans/s`;
      rows[2].textContent = last ? `${num(last.prompt)} tokens · ${secs(last.ms)}` : '—';
      rows[3].textContent = last ? last.model : S.settings.models.translate;
    }
  }
}

/* ---------- Settings ---------- */
function renderSettings() {
  const s = S.settings;
  const langs = Object.entries(S.languages);
  const langOpts = (sel, withAuto) => langs.filter(([c]) => withAuto || c !== 'auto').map(([c, n]) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c === 'auto' ? 'Detect automatically' : esc(n)}</option>`).join('');
  const modelOpts = (sel) => {
    const list = S.models.length ? S.models.filter((m) => /^gemini/.test(m) && !/tts|image|embedding|live|audio/.test(m)) : [sel];
    if (!list.includes(sel)) list.unshift(sel);
    return list.map((m) => `<option ${m === sel ? 'selected' : ''}>${esc(m)}</option>`).join('');
  };
  const fonts = ['', 'Microsoft YaHei UI', 'SimHei', 'DengXian', 'KaiTi', 'Yu Gothic UI', 'Malgun Gothic', 'Segoe UI'];
  const k = S.key || {};
  main.innerHTML = `
    <div class="pagehead"><div><h1>Settings</h1><p>Changes apply immediately, also while a game is running.</p></div>
      <div class="actions"><button class="btn ghost" id="open-config">Open config folder</button><button class="btn ghost" id="open-data">Open data folder</button></div></div>
    <section class="section"><h2>How translations appear</h2>
      <div class="modes">
        <button class="mode" data-mode="replace" aria-pressed="${s.display.mode === 'replace'}"><div class="mini"><div class="mbox"><div class="ln"></div><div class="ln short"></div></div></div><b>Replace in place</b><p>The translation covers the original text in the game's own box. Reads like a localized game.</p></button>
        <button class="mode" data-mode="band" aria-pressed="${s.display.mode === 'band'}"><div class="mini"><div class="mbox"><div class="ln jpx"></div><div class="ln jpx short"></div></div><div class="band"><div class="ln"></div><div class="ln short"></div></div></div><b>Subtitle band</b><p>The original stays visible. The translation sits just above it. Good for learning the language.</p></button>
        <button class="mode" data-mode="panel" aria-pressed="${s.display.mode === 'panel'}"><div class="mini split"><div class="g"><div class="mbox"><div class="ln jpx"></div><div class="ln jpx short"></div></div></div><div class="p"><div class="ln"></div><div class="ln short"></div><div class="ln"></div><div class="ln hl"></div><div class="ln hl short"></div></div></div><b>Side panel</b><p>Nothing is drawn over the game. Read translations in the Live session page on a second monitor.</p></button>
      </div>
    </section>
    <div class="scols2">
      <section class="section"><h2>Languages and reading</h2><div class="box">
        <div class="rowi"><div class="lbl"><b>Game language</b><small>Detection works for most games. Set it when a game mixes languages.</small></div><div class="ctl"><select class="input" id="lang-src">${langOpts(s.languages.source, true)}</select></div></div>
        <div class="rowi"><div class="lbl"><b>Translate into</b></div><div class="ctl"><select class="input" id="lang-tgt">${langOpts(s.languages.target, false)}</select></div></div>
        <div class="rowi"><div class="lbl"><b>Wait before translating</b><small>Text must stop changing this long. Lets typewriter dialogue finish first.</small></div><div class="ctl"><div class="range"><input type="range" id="stable" min="100" max="800" step="50" value="${s.translate.stable_wait_ms}"><output id="stable-o">${s.translate.stable_wait_ms} ms</output></div></div></div>
        <div class="rowi"><div class="lbl"><b>Screen scans per second</b><small>Higher reacts sooner and uses a little more CPU.</small></div><div class="ctl"><div class="range"><input type="range" id="scan" min="4" max="15" step="1" value="${s.translate.scan_per_second}"><output id="scan-o">${s.translate.scan_per_second} / s</output></div></div></div>
        <div class="rowi"><div class="lbl"><b>Recent dialogue sent with each line</b><small>More lines give better pronouns and tone, and cost slightly more.</small></div><div class="ctl"><div class="range"><input type="range" id="ctx" min="0" max="30" value="${s.translate.context_lines}"><output id="ctx-o">${s.translate.context_lines} lines</output></div></div></div>
        <div class="rowi"><div class="lbl"><b>Areas to ignore or read</b><small>Draw them over the game for the running game.</small></div><div class="ctl"><button class="btn" id="zones" ${running() ? '' : 'disabled'}>Draw areas ${kbd(s.hotkeys.zones)}</button></div></div>
      </div></section>
      <section class="section"><h2>Drawing the translation</h2><div class="box">
        <div class="rowi"><div class="lbl"><b>Font</b><small>Automatic picks a clear system font for the target language.</small></div><div class="ctl"><select class="input" id="font">${fonts.map((f) => `<option value="${esc(f)}" ${f === s.display.font_family ? 'selected' : ''}>${f || 'Automatic'}</option>`).join('')}</select></div></div>
        <div class="rowi"><div class="lbl"><b>Smallest text size</b><small>A translation never shrinks below this. It wraps instead.</small></div><div class="ctl"><div class="range"><input type="range" id="minfont" min="9" max="24" value="${s.display.min_font_px}"><output id="minfont-o">${s.display.min_font_px} px</output></div></div></div>
        <div class="rowi"><div class="lbl"><b>Status badge</b><small>The small pill in the corner of the game.</small></div><div class="ctl"><label class="toggle" for="hud"><input type="checkbox" id="hud" ${s.display.show_hud ? 'checked' : ''}> Show</label></div></div>
        <div class="rowi"><div class="lbl"><b>Hold to see the original</b></div><div class="ctl"><select class="input" id="peek">${['Alt', 'Ctrl', 'Shift', 'CapsLock'].map((x) => `<option ${x === s.display.peek_key ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
      </div></section>
    </div>
    <div class="scols2">
      <section class="section"><h2>Model</h2><div class="box">
        <div class="rowi"><div class="lbl"><b>Translation model</b><small>Used for every screen. Busy models fall back to the next in line automatically.</small></div><div class="ctl"><select class="input" id="m-tr">${modelOpts(s.models.translate)}</select></div></div>
        <div class="rowi"><div class="lbl"><b>Fallbacks</b><small>Tried in order when the main model is busy.</small></div><div class="ctl"><input class="input" id="m-fb" value="${esc((s.models.translate_fallbacks || []).join(', '))}"></div></div>
        <div class="rowi"><div class="lbl"><b>Profile model</b><small>Drafts and updates game profiles in the background.</small></div><div class="ctl"><select class="input" id="m-pr">${modelOpts(s.models.profile)}</select></div></div>
        <div class="rowi"><div class="lbl"><b>Draft a profile on first play</b><small>Searches the web for a new game's cast and terms, then keeps the profile updated as you play.</small></div><div class="ctl"><label class="toggle" for="autoprof"><input type="checkbox" id="autoprof" ${s.profile.identify_on_first_play ? 'checked' : ''}> On</label></div></div>
        <div class="rowi"><div class="lbl"><b>Gemini key</b><small>${k.saved ? `Key ending in …${esc(k.hint)}, encrypted with your Windows account.` : 'No key saved yet.'}</small></div><div class="ctl"><button class="btn" id="key">${k.saved ? 'Replace key' : 'Add key'}</button></div></div>
        <div class="rowi"><div class="lbl"><b>What leaves your PC</b><small>The parts of the game screen that changed. For a new game, also one picture of its window, to identify it. Never the rest of your desktop.</small></div><div class="ctl"><span class="chip">Always</span></div></div>
      </div></section>
      <section class="section"><h2>Keys</h2><div class="box">
        ${[['toggle', 'Start or pause the overlay'], ['retranslate', 'Translate this screen again'], ['show_log', 'Open the session log'], ['zones', 'Draw areas to ignore or read']].map(([key, label]) => `
        <div class="rowi"><div class="lbl"><b>${label}</b></div><div class="ctl"><input class="input mono" data-hotkey="${key}" value="${esc(s.hotkeys[key])}" style="max-width:160px"></div></div>`).join('')}
        <div class="rowi"><div class="lbl"><small>Use names like F8, Ctrl+F8 or Alt+Shift+T. A key a game needs, such as its quick-load key, should be moved here.</small></div><div class="ctl"><button class="btn sm" id="save-keys">Save keys</button></div></div>
      </div></section>
    </div>`;

  const save = (patch, msg = 'Saved') => act(async () => { S.settings = await call('settings:save', patch); renderRunstate(); }, msg);
  $$('.mode').forEach((m) => m.onclick = () => { $$('.mode').forEach((x) => x.setAttribute('aria-pressed', String(x === m))); save({ display: { mode: m.dataset.mode } }); });
  const range = (id, fmt, patch) => { const i = $('#' + id), o = $('#' + id + '-o'); i.oninput = () => { o.textContent = fmt(i.value); }; i.onchange = () => save(patch(Number(i.value))); };
  range('stable', (v) => v + ' ms', (v) => ({ translate: { stable_wait_ms: v } }));
  range('scan', (v) => v + ' / s', (v) => ({ translate: { scan_per_second: v } }));
  range('ctx', (v) => v + ' lines', (v) => ({ translate: { context_lines: v } }));
  range('minfont', (v) => v + ' px', (v) => ({ display: { min_font_px: v } }));
  $('#lang-src').onchange = (e) => save({ languages: { source: e.target.value } });
  $('#lang-tgt').onchange = (e) => save({ languages: { target: e.target.value } });
  $('#font').onchange = (e) => save({ display: { font_family: e.target.value } });
  $('#hud').onchange = (e) => save({ display: { show_hud: e.target.checked } });
  $('#peek').onchange = (e) => save({ display: { peek_key: e.target.value } });
  $('#m-tr').onchange = (e) => save({ models: { translate: e.target.value } });
  $('#m-pr').onchange = (e) => save({ models: { profile: e.target.value } });
  $('#m-fb').onchange = (e) => save({ models: { translate_fallbacks: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } });
  $('#autoprof').onchange = (e) => save({ profile: { identify_on_first_play: e.target.checked } });
  $('#zones').onclick = () => act(() => call('zones:edit'), 'Draw areas on the game screen');
  $('#key').onclick = async () => { const k2 = await act(() => call('key:replace')); if (k2) { S.key = k2; renderSettings(); toast(k2.saved ? `Key ending in …${k2.hint} saved` : 'No key saved'); } };
  $('#save-keys').onclick = () => { const hk = {}; $$('[data-hotkey]').forEach((i) => { hk[i.dataset.hotkey] = i.value.trim(); }); save({ hotkeys: hk }, 'Keys saved'); };
  $('#open-config').onclick = () => call('folder:open', 'config');
  $('#open-data').onclick = () => call('folder:open', 'data');
}

/* ---------- live events ---------- */
api.on('session:status', (st) => {
  const wasPaused = S.session && S.session.paused;
  S.session = st; S.game = st.game;
  renderRunstate();
  updateSessionLive();
  if (S.page === 'games' && wasPaused !== st.paused) renderGames();
});
api.on('app:session', async (d) => {
  if (!d.running) { S.session = null; S.game = null; if (d.reason && d.reason !== 'switch') toast(d.reason); }
  await loadGames().catch(() => {});
  if (S.page === 'games') renderGames();
  renderRunstate();
});
api.on('session:line', (l) => {
  if (!S.transcript || (S.gameId && S.game && S.gameId !== S.game.id)) return;
  S.transcript.push(l);
  if (S.page === 'session' && S.editingLine === null) {
    const log = $('#log');
    if (log) {
      const emptyEl = log.querySelector('.empty'); if (emptyEl) emptyEl.remove();
      log.insertAdjacentHTML('afterbegin', entryHtml(l));
      log.firstElementChild.classList.add('fresh');
      bindSession();
    }
  }
});
api.on('session:line-updated', (l) => {
  const i = (S.transcript || []).findIndex((x) => x.id === l.id);
  if (i >= 0) S.transcript[i] = l;
  if (S.page === 'session' && S.editingLine === null) renderSession();
});
api.on('session:terms', (t) => { S.terms = t; if (S.page === 'session' && S.editingLine === null) renderSession(); });
api.on('session:conflicts', (c) => { S.conflicts = c; });
api.on('session:error', (e) => { S.lastError = { ...e, at: Date.now() }; if (S.page === 'session') renderSession(); });
api.on('profile:changed', (p) => {
  if (S.profileData && running() && S.profileData.id === S.game.id && !S.profileDirty) {
    S.profileData.profile = p;
    if (S.page === 'profile') renderProfile();
  }
});
api.on('profile:status', (st) => {
  S.profileStatus = st.status;
  if (st.status === 'failed') S.lastError = { short: 'Profile draft failed', message: st.message, at: Date.now() };
  if (st.status === 'ready') toast('Game profile drafted');
  if (S.page === 'profile' && !S.profileDirty) { S.profileData = null; renderProfile(); }
});
api.on('ui:navigate', (p) => go(p));
api.on('zones:changed', () => toast('Areas saved'));

/* ---------- start ---------- */
(async () => {
  try {
    const st = await call('app:state');
    S.settings = st.settings; S.key = st.key; S.languages = st.languages;
    if (st.session) { S.session = st.session; S.game = st.game; }
    S.models = await call('models:list').catch(() => []);
    await loadGames();
    const hash = location.hash.replace('#', '');
    go(['games', 'profile', 'session', 'settings'].includes(hash) ? hash : 'games');
  } catch (e) {
    main.innerHTML = `<div class="banner bad"><div><b>The app could not start.</b><small>${esc(e.message)}</small></div></div>`;
  }
})();
