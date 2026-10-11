'use strict';
/* Overlay window: transparent, click-through, always on top of the game.
   Paints each translated block at its box. Boxes arrive in captured-frame pixels. */
const layer = document.getElementById('layer');
const hud = document.getElementById('hud');
const hudText = document.getElementById('hud-text');
const hudPair = document.getElementById('hud-pair');
const hudKey = document.getElementById('hud-key');
const zoneLayer = document.getElementById('zones');
const zoneBar = document.getElementById('zonebar');

let frame = { width: 1, height: 1 };
let opts = { mode: 'replace', minFontPx: 14, fontFamily: '', showHud: true };
const blocks = new Map();   // id -> { el, data }

const scale = () => window.innerWidth / frame.width;

function familyFor(lang) {
  if (opts.fontFamily) return `${opts.fontFamily}, "Segoe UI", sans-serif`;
  switch (lang) {
    case 'zh-Hans': return '"Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif';
    case 'zh-Hant': return '"Microsoft JhengHei UI", "Microsoft JhengHei", sans-serif';
    case 'ja': return '"Yu Gothic UI", "Meiryo UI", sans-serif';
    case 'ko': return '"Malgun Gothic", sans-serif';
    default: return '"Segoe UI", system-ui, sans-serif';
  }
}

function place(el, x, y, w, h) {
  el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.width = w + 'px'; el.style.height = h + 'px';
}

// Fits the translation into the box, starting at the original's measured size.
// Single lines: shrink a little, then widen to the right, then shrink further, and wrap last.
// The smallest-size setting is a floor only when the original text is larger than it.
const overflows = (el, span) => span.scrollHeight > el.clientHeight + 1 || span.scrollWidth > el.clientWidth + 1;
function fit(el, span, startPx, { single, maxWidthPx, maxGrowPx }) {
  const soft = Math.max(8, startPx * 0.82);
  const hard = Math.max(8, Math.min(opts.minFontPx * scale(), startPx * 0.6));
  let size = Math.max(8, startPx);
  const set = (v) => { size = v; span.style.fontSize = v + 'px'; };
  const shrinkTo = (limit) => { let g = 60; while (g-- > 0 && size > limit && overflows(el, span)) set(Math.max(limit, size * 0.94)); };
  span.style.whiteSpace = single ? 'nowrap' : 'pre-wrap';
  set(size);
  if (single && span.scrollWidth > el.clientWidth + 1) {
    // A label keeps the original size and takes room to its right when the translation is longer.
    el.style.width = Math.min(Math.ceil(span.scrollWidth) + 12, maxWidthPx) + 'px';
  } else {
    shrinkTo(soft);
  }
  shrinkTo(hard);
  if (single && overflows(el, span)) span.style.whiteSpace = 'pre-wrap';
  if (span.scrollHeight > el.clientHeight + 1 && maxGrowPx > 0) {
    const extra = Math.min(maxGrowPx, span.scrollHeight - el.clientHeight + 4);
    el.style.height = (el.clientHeight + extra) + 'px';
  }
}
function applyAlign(el, span, align) {
  el.style.justifyContent = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
  span.style.textAlign = align || 'left';
}

function render(id) {
  const b = blocks.get(id);
  if (!b) return;
  const d = b.data, s = scale();
  const el = b.el;
  el.className = `patch kind-${d.kind || 'other'} mode-${opts.mode}`;
  el.hidden = !d.visible || opts.mode === 'panel' || !d.text;
  if (el.hidden) return;
  const span = el.firstChild;
  span.textContent = d.text;
  span.style.fontFamily = familyFor(d.lang);
  const bx = d.box.x * s, by = d.box.y * s, bw = d.box.w * s, bh = d.box.h * s;

  if (opts.mode === 'band') {
    el.style.background = 'rgba(8, 10, 16, 0.86)';
    el.style.backgroundImage = '';
    span.style.color = '#fff3c4';
    span.style.textShadow = 'none';
    const w = Math.min(window.innerWidth, d.kind === 'dialogue' ? bw : Math.max(bw * 1.8, 90));
    const h = Math.max(24, Math.min(bh, 64 * s + 20));
    let top = by - h - 4;
    if (top < 0) top = by + bh + 4;
    const left = Math.min(Math.max(0, d.kind === 'dialogue' ? bx : bx + bw / 2 - w / 2), window.innerWidth - w);
    place(el, left, top, w, h);
    applyAlign(el, span, 'center');
    fit(el, span, Math.max(opts.minFontPx * s, d.style.fontPx * s), { single: false, maxWidthPx: w, maxGrowPx: 120 });
    return;
  }

  place(el, bx, by, bw, bh);
  if (d.style.plate) {
    el.style.background = '';
    el.style.backgroundImage = `url(${d.style.plate})`;
  } else {
    el.style.backgroundImage = '';
    el.style.background = d.style.fill || 'rgba(10,12,20,0.9)';
  }
  span.style.color = d.style.color;
  span.style.textShadow = d.style.shadow ? '0 0 3px rgba(0,0,0,.9), 0 1px 2px rgba(0,0,0,.9)' : 'none';
  const lines = d.lines || 1;
  span.style.lineHeight = lines > 1 ? String(d.style.lineHeight || 1.45) : '1.05';
  applyAlign(el, span, d.align);
  const roomRight = Math.max(bw, Math.min(window.innerWidth - bx, (d.maxW || d.box.w) * s, bw * 3));
  fit(el, span, d.style.fontPx * s, { single: lines === 1, maxWidthPx: roomRight, maxGrowPx: d.kind === 'dialogue' ? bh * 0.6 : bh * 0.4 });
  if (opts.debug) console.log('fit', JSON.stringify({ id, kind: d.kind, lines, start: Math.round(d.style.fontPx * s * 10) / 10, font: parseFloat(span.style.fontSize), w: el.clientWidth, h: el.clientHeight, s: Math.round(s * 1000) / 1000, innerW: window.innerWidth, frameW: frame.width, text: d.text.slice(0, 16) }));
}

function upsert(list) {
  for (const d of list) {
    if (d.removed) { remove([d.id]); continue; }
    let b = blocks.get(d.id);
    if (!b) {
      const el = document.createElement('div');
      el.appendChild(document.createElement('span'));
      layer.appendChild(el);
      b = { el, data: d };
      blocks.set(d.id, b);
    } else {
      b.data = { ...b.data, ...d };
    }
    render(d.id);
  }
}
function remove(ids) {
  for (const id of ids) { const b = blocks.get(id); if (b) { b.el.remove(); blocks.delete(id); } }
}

api.on('overlay:frame', (f) => { frame = f; for (const id of blocks.keys()) render(id); });
api.on('overlay:paint', upsert);
api.on('overlay:visibility', (list) => {
  for (const v of list) { const b = blocks.get(v.id); if (b) { b.data.visible = v.visible; render(v.id); } }
});
api.on('overlay:remove', remove);
api.on('overlay:clear', () => remove([...blocks.keys()]));
api.on('overlay:mode', (o) => {
  opts = { ...opts, ...o };
  hud.hidden = !opts.showHud;
  for (const id of blocks.keys()) render(id);
});
api.on('overlay:peek', (p) => document.body.classList.toggle('peek', !!p));
api.on('overlay:hud', (h) => {
  hud.dataset.state = h.state;
  hudText.textContent = h.text;
  if (h.pair) hudPair.textContent = h.pair;
  if (h.key) hudKey.textContent = h.key;
});
window.addEventListener('resize', () => { for (const id of blocks.keys()) render(id); });

/* ---------- zone editor ---------- */
let zoneState = null;   // { ignore:[], read:[], only_read, tool }
function drawZones() {
  zoneLayer.innerHTML = '';
  if (!zoneState) return;
  const W = window.innerWidth, H = window.innerHeight;
  for (const kind of ['ignore', 'read']) {
    zoneState[kind].forEach((z, i) => {
      const el = document.createElement('div');
      el.className = `zone ${kind}`;
      place(el, z.x * W, z.y * H, z.w * W, z.h * H);
      el.textContent = kind === 'ignore' ? 'Ignored' : 'Read';
      el.title = 'Click to remove';
      el.addEventListener('mousedown', (e) => { e.stopPropagation(); zoneState[kind].splice(i, 1); drawZones(); });
      zoneLayer.appendChild(el);
    });
  }
  document.getElementById('z-only').checked = !!zoneState.only_read;
}
api.on('overlay:zones', (z) => {
  zoneState = z ? { ignore: [...(z.ignore || [])], read: [...(z.read || [])], only_read: !!z.only_read, tool: 'ignore' } : null;
  document.body.classList.toggle('editing', !!zoneState);
  zoneBar.hidden = !zoneState;
  setTool('ignore');
  drawZones();
});
function setTool(t) {
  if (zoneState) zoneState.tool = t;
  document.querySelectorAll('#zonebar [data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
}
document.querySelectorAll('#zonebar [data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.getElementById('z-only').addEventListener('change', (e) => { if (zoneState) zoneState.only_read = e.target.checked; });
document.getElementById('z-clear').addEventListener('click', () => { if (zoneState) { zoneState.ignore = []; zoneState.read = []; drawZones(); } });
document.getElementById('z-done').addEventListener('click', () => {
  const { tool, ...z } = zoneState || {};
  api.send('overlay:zones-save', z);
});
document.getElementById('z-cancel').addEventListener('click', () => api.send('overlay:zones-save', null));
window.addEventListener('keydown', (e) => { if (zoneState && e.key === 'Escape') api.send('overlay:zones-save', null); });

let drag = null;
zoneLayer.addEventListener('mousedown', (e) => {
  if (!zoneState) return;
  drag = { x: e.clientX, y: e.clientY, el: document.createElement('div') };
  drag.el.className = `zone ${zoneState.tool} drawing`;
  zoneLayer.appendChild(drag.el);
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  place(drag.el, Math.min(drag.x, e.clientX), Math.min(drag.y, e.clientY), Math.abs(e.clientX - drag.x), Math.abs(e.clientY - drag.y));
});
window.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const W = window.innerWidth, H = window.innerHeight;
  const x = Math.min(drag.x, e.clientX), y = Math.min(drag.y, e.clientY), w = Math.abs(e.clientX - drag.x), h = Math.abs(e.clientY - drag.y);
  drag.el.remove(); drag = null;
  if (w > 12 && h > 12 && zoneState) { zoneState[zoneState.tool].push({ x: x / W, y: y / H, w: w / W, h: h / H }); drawZones(); }
});
