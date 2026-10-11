'use strict';
/* Capture engine (hidden window).
   Watches the game window, finds parts of the screen that changed and then settled,
   crops them for translation, and decides which painted translations still match
   the pixels beneath them. Works on a small grayscale copy of each frame split into
   8x8 cells; crops and colour sampling use the full-resolution frame. */

const CELL = 8;            // cell size in small-image pixels
const SMALL_W = 480;       // small-image width
const WARMUP_MS = 900;
const ANIM_WINDOW_MS = 3000;
const ANIM_CHANGES = 4;
const ANIM_HOLD_MS = 6000;

let cfg = { scanPerSecond: 8, stableMs: 200, maxImageWidth: 1600 };
let video = null, stream = null, timer = null, paused = false;
let fw = 0, fh = 0, sw = 0, sh = 0, k = 1, gw = 0, gh = 0, cellPx = 0;
let small, sctx, full, fctx;
let cur, prev, committed, committedSet, commitAt, lastChange, animUntil, changeLog, zoneMask, cursorMask;
let startAt = 0;
let cursorPos = null;
const cursorTrail = [];   // recent pointer positions: { x, y, t }
const recentBoxes = [];   // recently sent region boxes: { box, t }
let zones = { ignore: [], read: [], only_read: false };
let regionSeq = 0, blockSeq = 0;
const regions = new Map();   // regionId -> { box, image: ImageData, canvas, lum: Uint8Array }
const blocks = new Map();    // blockId -> { box, cells: Int32Array, snap: Uint8Array, visible, data }
let fpsCount = 0, fpsAt = performance.now(), fps = 0;
let lastStatusAt = 0;

function log(...a) { api.send('engine:log', a.map(String).join(' ')); }

/* ---------- setup ---------- */
async function start(opts) {
  stop();
  cfg = { ...cfg, ...opts.cfg };
  zones = opts.zones || zones;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15, cursor: 'never' }, audio: false });
  } catch (e) {
    api.send('engine:error', `Could not capture the game window: ${e.message}`);
    return;
  }
  video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  stream.getVideoTracks()[0].addEventListener('ended', () => api.send('engine:error', 'The game window closed or can no longer be captured.'));
  startAt = performance.now();
  timer = setInterval(tick, Math.round(1000 / cfg.scanPerSecond));
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; video = null; fw = 0; fh = 0;
  regions.clear(); blocks.clear();
}

function initSize(w, h) {
  fw = w; fh = h;
  sw = Math.min(SMALL_W, fw);
  k = fw / sw;
  sh = Math.max(CELL, Math.round(fh / k));
  gw = Math.ceil(sw / CELL); gh = Math.ceil(sh / CELL);
  cellPx = CELL * k;
  small = document.createElement('canvas'); small.width = sw; small.height = sh;
  sctx = small.getContext('2d', { willReadFrequently: true });
  full = document.createElement('canvas');
  fctx = full.getContext('2d', { willReadFrequently: true });
  const n = sw * sh, c = gw * gh;
  cur = new Uint8Array(n); prev = new Uint8Array(n); committed = new Uint8Array(n);
  committedSet = new Uint8Array(c); commitAt = new Float64Array(c); lastChange = new Float64Array(c); animUntil = new Float64Array(c);
  changeLog = Array.from({ length: c }, () => []);
  zoneMask = new Uint8Array(c); cursorMask = new Uint8Array(c);
  buildZoneMask();
  regions.clear(); blocks.clear();
  startAt = performance.now();
  api.send('engine:frame', { width: fw, height: fh });
}

function buildZoneMask() {
  if (!zoneMask) return;
  zoneMask.fill(zones.only_read && zones.read.length ? 1 : 0);
  const mark = (z, v) => {
    const x0 = Math.floor(z.x * gw), y0 = Math.floor(z.y * gh);
    const x1 = Math.ceil((z.x + z.w) * gw), y1 = Math.ceil((z.y + z.h) * gh);
    for (let y = Math.max(0, y0); y < Math.min(gh, y1); y++) for (let x = Math.max(0, x0); x < Math.min(gw, x1); x++) zoneMask[y * gw + x] = v;
  };
  if (zones.only_read) for (const z of zones.read) mark(z, 0);
  for (const z of zones.ignore) mark(z, 1);
}

/* ---------- cell maths ---------- */
// Compares cell i of two luminance images. Returns true when they differ visibly.
function cellDiff(a, b, i) {
  const cx = (i % gw) * CELL, cy = Math.floor(i / gw) * CELL;
  const x1 = Math.min(cx + CELL, sw), y1 = Math.min(cy + CELL, sh);
  let sum = 0, max = 0, n = 0;
  for (let y = cy; y < y1; y++) {
    let o = y * sw + cx;
    for (let x = cx; x < x1; x++, o++) {
      const d = a[o] > b[o] ? a[o] - b[o] : b[o] - a[o];
      sum += d; if (d > max) max = d; n++;
    }
  }
  return max > 28 || sum / n > 2.5;
}
// Any movement at all between consecutive frames. Static game pixels are bit-identical frame to frame,
// so even slow glows, breathing sprites and drifting water register here and get classed as animation.
function cellMoved(a, b, i) {
  const cx = (i % gw) * CELL, cy = Math.floor(i / gw) * CELL;
  const x1 = Math.min(cx + CELL, sw), y1 = Math.min(cy + CELL, sh);
  let sum = 0, max = 0, n = 0;
  for (let y = cy; y < y1; y++) {
    let o = y * sw + cx;
    for (let x = cx; x < x1; x++, o++) {
      const d = a[o] > b[o] ? a[o] - b[o] : b[o] - a[o];
      sum += d; if (d > max) max = d; n++;
    }
  }
  return max > 5 || sum / n > 0.35;
}
function cellDiffSnap(snap, si, i, loose) {
  const cx = (i % gw) * CELL, cy = Math.floor(i / gw) * CELL;
  const x1 = Math.min(cx + CELL, sw), y1 = Math.min(cy + CELL, sh);
  let sum = 0, max = 0, n = 0, s = si * CELL * CELL;
  for (let y = cy; y < y1; y++) {
    let o = y * sw + cx;
    for (let x = cx; x < x1; x++, o++, s++) {
      const d = cur[o] > snap[s] ? cur[o] - snap[s] : snap[s] - cur[o];
      sum += d; if (d > max) max = d; n++;
    }
    s += CELL - (x1 - cx);
  }
  // Animated cells get a loose test: their own motion is small, a scene change is not.
  return loose ? (max > 110 || sum / n > 16) : (max > 28 || sum / n > 2.5);
}
function copyCell(src, dst, i) {
  const cx = (i % gw) * CELL, cy = Math.floor(i / gw) * CELL;
  const x1 = Math.min(cx + CELL, sw), y1 = Math.min(cy + CELL, sh);
  for (let y = cy; y < y1; y++) dst.set(src.subarray(y * sw + cx, y * sw + x1), y * sw + cx);
}
function cellsInBox(b) {
  const x0 = Math.max(0, Math.floor(b.x / cellPx)), y0 = Math.max(0, Math.floor(b.y / cellPx));
  const x1 = Math.min(gw - 1, Math.floor((b.x + b.w - 1) / cellPx)), y1 = Math.min(gh - 1, Math.floor((b.y + b.h - 1) / cellPx));
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(y * gw + x);
  return Int32Array.from(out);
}
function snapCells(lum, cells) {
  const snap = new Uint8Array(cells.length * CELL * CELL);
  cells.forEach((i, si) => {
    const cx = (i % gw) * CELL, cy = Math.floor(i / gw) * CELL;
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const sx = Math.min(cx + x, sw - 1), sy = Math.min(cy + y, sh - 1);
      snap[si * CELL * CELL + y * CELL + x] = lum[sy * sw + sx];
    }
  });
  return snap;
}

/* ---------- main loop ---------- */
function tick() {
  if (paused || !video || video.readyState < 2) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  if (vw !== fw || vh !== fh) initSize(vw, vh);

  sctx.drawImage(video, 0, 0, sw, sh);
  const px = sctx.getImageData(0, 0, sw, sh).data;
  for (let i = 0, o = 0; i < cur.length; i++, o += 4) cur[i] = (px[o] * 77 + px[o + 1] * 150 + px[o + 2] * 29) >> 8;

  const now = performance.now();
  fpsCount++;
  if (now - fpsAt > 1000) { fps = fpsCount * 1000 / (now - fpsAt); fpsCount = 0; fpsAt = now; }
  const ncell = gw * gh;

  // 1. Which cells changed since the last frame; flag cells that keep changing as animated.
  for (let i = 0; i < ncell; i++) {
    if (cellMoved(cur, prev, i)) {
      lastChange[i] = now;
      const log = changeLog[i];
      log.push(now);
      while (log.length && now - log[0] > ANIM_WINDOW_MS) log.shift();
      if (log.length >= ANIM_CHANGES) animUntil[i] = now + ANIM_HOLD_MS;
    }
  }
  prev.set(cur);

  // 2. Cells under the mouse pointer are ignored.
  // 2. Cells under the pointer, and where it was in the last moment, are ignored.
  cursorMask.fill(0);
  if (cursorPos) cursorTrail.push({ x: cursorPos.x, y: cursorPos.y, t: now });
  while (cursorTrail.length && now - cursorTrail[0].t > 450) cursorTrail.shift();
  for (const p of cursorTrail) {
    // The arrow hangs down and right from its tip: about 16 x 24 px at normal size.
    const x0 = Math.floor((p.x - 4) / cellPx), x1 = Math.floor((p.x + 18) / cellPx);
    const y0 = Math.floor((p.y - 4) / cellPx), y1 = Math.floor((p.y + 26) / cellPx);
    for (let y = Math.max(0, y0); y <= Math.min(gh - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(gw - 1, x1); x++) cursorMask[y * gw + x] = 1;
  }
  const eligible = (i) => !zoneMask[i] && !cursorMask[i] && animUntil[i] < now;

  // 3. Painted translations stay visible only while the pixels under them are unchanged.
  const vis = [];
  const covered = new Uint8Array(ncell);
  for (const [id, b] of blocks) {
    let match = true, checked = 0;
    for (let si = 0; si < b.cells.length; si++) {
      const i = b.cells[si];
      if (cursorMask[i]) continue;
      checked++;
      // Animating cells get the loose test: their own motion is small, a scene change is not.
      if (cellDiffSnap(b.snap, si, i, animUntil[i] >= now)) { match = false; break; }
    }
    const visible = checked === 0 ? b.visible : match;
    if (visible !== b.visible) { b.visible = visible; vis.push({ id, visible }); }
    if (visible) for (const i of b.cells) covered[i] = 1;
  }
  if (vis.length) api.send('engine:visibility', vis);

  // 4. Changed cells, waiting until they settle.
  let unsettled = 0, animated = 0;
  const dirty = new Uint8Array(ncell);
  for (let i = 0; i < ncell; i++) {
    if (animUntil[i] >= now) animated++;
    if (!eligible(i)) continue;
    if (!committedSet[i] || cellDiff(cur, committed, i)) {
      dirty[i] = 1;
      if (now - lastChange[i] < cfg.stableMs) { dirty[i] = 2; unsettled++; }
    }
  }
  if (now - lastStatusAt > 400) {
    lastStatusAt = now;
    api.send('engine:status', { fps: Math.round(fps * 10) / 10, unsettled, animated, blocks: blocks.size, visible: [...blocks.values()].filter((b) => b.visible).length });
  }
  if (now - startAt < WARMUP_MS) return;

  // 5. Group changed cells into regions. A region is ready when none of its cells is still changing.
  const seen = new Uint8Array(ncell);
  const ready = [];
  for (let i = 0; i < ncell; i++) {
    if (!dirty[i] || seen[i]) continue;
    const comp = [];
    let busy = false;
    const q = [i]; seen[i] = 1;
    // Text runs sideways, so the reach is wider across than down. Cells that changed in the last
    // few seconds join too, so a line that resumes typing is sent whole, not as its new tail.
    while (q.length) {
      const c = q.pop(); comp.push(c);
      if (dirty[c] === 2) busy = true;
      const cx = c % gw, cy = (c / gw) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -5; dx <= 5; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (dirty[n] && !seen[n]) { seen[n] = 1; q.push(n); }
      }
    }
    // One step out (not transitive): recently changed cells next to the change join, so a line that
    // resumes typing is sent whole, without spreading across a screen that just changed everywhere.
    const extra = new Set();
    for (const c of comp) {
      const cx = c % gw, cy = (c / gw) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -6; dx <= 6; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (!dirty[n] && commitAt[n] && now - commitAt[n] < 4000 && eligible(n)) extra.add(n);
      }
    }
    for (const n of extra) comp.push(n);
    if (!busy) ready.push(comp);
  }
  if (!ready.length) return;

  const out = [];
  for (const comp of ready) {
    const changed = comp.filter((c) => dirty[c]);
    for (const c of changed) { if (committedSet[c]) commitAt[c] = now; copyCell(cur, committed, c); committedSet[c] = 1; }
    if (changed.length < 2) continue;                     // single-cell flickers are never text worth a request
    if (changed.every((c) => covered[c])) continue;       // pixels returned to a state that is already translated
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
    for (const c of comp) { const cx = c % gw, cy = (c / gw) | 0; if (cx < x0) x0 = cx; if (cy < y0) y0 = cy; if (cx > x1) x1 = cx; if (cy > y1) y1 = cy; }
    const pad = cellPx * 0.5;
    const box = {
      x: Math.max(0, Math.floor(x0 * cellPx - pad)), y: Math.max(0, Math.floor(y0 * cellPx - pad)),
    };
    box.w = Math.min(fw, Math.ceil((x1 + 1) * cellPx + pad)) - box.x;
    box.h = Math.min(fh, Math.ceil((y1 + 1) * cellPx + pad)) - box.y;
    out.push(box);
  }
  if (!out.length) return;
  // Layout memory: a region overlapping one sent recently grows to that region's box, so the same
  // panel always yields the same crop (stable cache hits, whole lines with their context).
  while (recentBoxes.length && now - recentBoxes[0].t > 90000) recentBoxes.shift();
  for (const b of out) {
    for (const r of recentBoxes) {
      const ix = Math.max(0, Math.min(b.x + b.w, r.box.x + r.box.w) - Math.max(b.x, r.box.x));
      const iy = Math.max(0, Math.min(b.y + b.h, r.box.y + r.box.h) - Math.max(b.y, r.box.y));
      const small = Math.min(b.w * b.h, r.box.w * r.box.h);
      if (ix * iy > 0.3 * small && r.box.w * r.box.h < fw * fh * 0.6) {
        const x = Math.min(b.x, r.box.x), y = Math.min(b.y, r.box.y);
        b.w = Math.max(b.x + b.w, r.box.x + r.box.w) - x; b.h = Math.max(b.y + b.h, r.box.y + r.box.h) - y; b.x = x; b.y = y;
      }
    }
  }
  for (const b of out) {
    const same = recentBoxes.find((r) => r.box.x === b.x && r.box.y === b.y && r.box.w === b.w && r.box.h === b.h);
    if (same) same.t = now; else if (b.w * b.h < fw * fh * 0.6) recentBoxes.push({ box: { ...b }, t: now });
  }
  if (recentBoxes.length > 24) recentBoxes.splice(0, recentBoxes.length - 24);
  // Too many separate pieces: send one region covering them all.
  let boxes = out;
  if (out.length > 6) {
    const u = out.reduce((a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), r: Math.max(a.r, b.x + b.w), bt: Math.max(a.bt, b.y + b.h) }), { x: fw, y: fh, r: 0, bt: 0 });
    boxes = [{ x: u.x, y: u.y, w: u.r - u.x, h: u.bt - u.y }];
  }
  api.send('engine:regions', boxes.map(makeRegion));
}

/* ---------- regions ---------- */
function makeRegion(box) {
  full.width = box.w; full.height = box.h;
  fctx.drawImage(video, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  const image = fctx.getImageData(0, 0, box.w, box.h);
  const canvas = document.createElement('canvas');
  canvas.width = box.w; canvas.height = box.h;
  canvas.getContext('2d').putImageData(image, 0, 0);

  // Encoded copy for the model, capped in width.
  const scale = Math.min(1, cfg.maxImageWidth / box.w);
  let enc = canvas;
  if (scale < 1) {
    enc = document.createElement('canvas');
    enc.width = Math.round(box.w * scale); enc.height = Math.round(box.h * scale);
    const ectx = enc.getContext('2d');
    ectx.imageSmoothingQuality = 'high';
    ectx.drawImage(canvas, 0, 0, enc.width, enc.height);
  }
  const url = enc.toDataURL('image/webp', 0.92);

  const id = ++regionSeq;
  const now = performance.now();
  regions.set(id, { box, image, canvas, lum: cur.slice(), at: now });   // same frame as the crop
  for (const [rid, r] of regions) { if (now - r.at > 60000 || regions.size > 150) regions.delete(rid); else break; }
  return {
    regionId: id, box, width: enc.width, height: enc.height,
    mime: 'image/webp', data: url.slice(url.indexOf(',') + 1), hash: dhash(canvas),
  };
}

// 2048-bit difference hash of a region, as hex. Fine enough that a changed line of text
// flips many bits, so the screen memory only matches a region whose text is the same.
function dhash(canvas) {
  const c = document.createElement('canvas'); c.width = 65; c.height = 32;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high';
  x.drawImage(canvas, 0, 0, 65, 32);
  const d = x.getImageData(0, 0, 65, 32).data;
  let hex = '', nib = 0, bits = 0;
  for (let y = 0; y < 32; y++) for (let i = 0; i < 64; i++) {
    const o = (y * 65 + i) * 4, o2 = o + 4;
    const a = d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29, b = d[o2] * 77 + d[o2 + 1] * 150 + d[o2 + 2] * 29;
    nib = (nib << 1) | (a > b ? 1 : 0);
    if (++bits === 4) { hex += nib.toString(16); nib = 0; bits = 0; }
  }
  return hex;
}

/* ---------- registering translated blocks ---------- */
function median(arr) { arr.sort((a, b) => a - b); return arr.length ? arr[arr.length >> 1] : 0; }

// Tightens the model's box onto the actual glyphs and samples background and text colours.
function refine(img, bx) {
  const W = img.width, H = img.height, d = img.data;
  let x0 = Math.max(0, Math.round(bx.x0)), y0 = Math.max(0, Math.round(bx.y0));
  let x1 = Math.min(W - 1, Math.round(bx.x1)), y1 = Math.min(H - 1, Math.round(bx.y1));
  if (x1 <= x0 || y1 <= y0) return null;
  const bh = y1 - y0;
  const m = Math.max(6, Math.min(28, Math.round(bh * 0.8)));
  const ex0 = Math.max(0, x0 - m), ey0 = Math.max(0, y0 - m), ex1 = Math.min(W - 1, x1 + m), ey1 = Math.min(H - 1, y1 + m);

  // Background: median colour of a 2 px ring around the expanded box.
  const R = [], G = [], B = [];
  const ring = (x, y) => { const o = (y * W + x) * 4; R.push(d[o]); G.push(d[o + 1]); B.push(d[o + 2]); };
  const step = Math.max(1, Math.floor((ex1 - ex0 + ey1 - ey0) / 400));
  for (let t = 0; t < 2; t++) {
    for (let x = ex0; x <= ex1; x += step) { ring(x, Math.min(ey1, ey0 + t)); ring(x, Math.max(ey0, ey1 - t)); }
    for (let y = ey0; y <= ey1; y += step) { ring(Math.min(ex1, ex0 + t), y); ring(Math.max(ex0, ex1 - t), y); }
  }
  // Most common colour in the ring is the background; glyph strokes touching the ring are a minority.
  const buckets = new Map();
  for (let i = 0; i < R.length; i++) {
    const key = ((R[i] >> 4) << 8) | ((G[i] >> 4) << 4) | (B[i] >> 4);
    const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += R[i]; e.g += G[i]; e.b += B[i];
    buckets.set(key, e);
  }
  let top = null;
  for (const e of buckets.values()) if (!top || e.n > top.n) top = e;
  const bg = top ? [Math.round(top.r / top.n), Math.round(top.g / top.n), Math.round(top.b / top.n)] : [median(R.slice()), median(G.slice()), median(B.slice())];
  let near = 0, dev = 0;
  for (let i = 0; i < R.length; i++) {
    const dd = (Math.abs(R[i] - bg[0]) + Math.abs(G[i] - bg[1]) + Math.abs(B[i] - bg[2])) / 3;
    if (dd < 18) { near++; dev += dd; }
  }
  let flatShare = near / Math.max(1, R.length);
  dev = near ? dev / near : 99;

  // Text on a chip, button or plate: the surrounding colour barely appears inside the box,
  // so the background is the most common colour inside the box instead.
  {
    const inB = new Map();
    let total = 0, ringLike = 0;
    const st = Math.max(1, Math.floor(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / 3000)));
    for (let y = y0; y <= y1; y += st) for (let x = x0; x <= x1; x += st) {
      const o = (y * W + x) * 4;
      total++;
      if ((Math.abs(d[o] - bg[0]) + Math.abs(d[o + 1] - bg[1]) + Math.abs(d[o + 2] - bg[2])) / 3 < 18) ringLike++;
      const key = ((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4);
      const e = inB.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += d[o]; e.g += d[o + 1]; e.b += d[o + 2];
      inB.set(key, e);
    }
    if (total && ringLike / total < 0.25) {
      let topIn = null;
      for (const e of inB.values()) if (!topIn || e.n > topIn.n) topIn = e;
      if (topIn) {
        bg[0] = Math.round(topIn.r / topIn.n); bg[1] = Math.round(topIn.g / topIn.n); bg[2] = Math.round(topIn.b / topIn.n);
        flatShare = topIn.n / total >= 0.45 ? 1 : 0;
        dev = 4;
      }
    }
  }

  // Text pixels: far from the background colour. Count them per row and per column.
  const T = 70 + Math.min(dev, 20) * 1.5;
  const ew = ex1 - ex0 + 1, eh = ey1 - ey0 + 1;
  const rows = new Int32Array(eh), cols = new Int32Array(ew);
  let count = 0;
  const TR = [], TG = [], TB = [];
  for (let y = ey0; y <= ey1; y++) {
    for (let x = ex0; x <= ex1; x++) {
      const o = (y * W + x) * 4;
      const dist = Math.abs(d[o] - bg[0]) + Math.abs(d[o + 1] - bg[1]) + Math.abs(d[o + 2] - bg[2]);
      if (dist > T) {
        // Rows are counted across the model's columns, columns across the model's rows,
        // so text belonging to a neighbouring block does not pull this one.
        if (x >= x0 && x <= x1) rows[y - ey0]++;
        if (y >= y0 && y <= y1) cols[x - ex0]++;
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
          count++;
          if ((count & 3) === 0) { TR.push(d[o]); TG.push(d[o + 1]); TB.push(d[o + 2]); }
        }
      }
    }
  }
  let fx0 = x0, fy0 = y0, fx1 = x1, fy1 = y1;
  let measured = null;
  if (count > 12) {
    // Tighten to the text inside the model's box, then grow outward only while text continues
    // without a gap: a blank row stops vertical growth, a gap wider than a space stops horizontal.
    // A row filled across nearly the whole box is a border or underline of a panel, not text.
    const mw = x1 - x0 + 1;
    const inRow = (y) => rows[y - ey0] > 0 && rows[y - ey0] < mw * 0.85, inCol = (x) => cols[x - ex0] > 0;
    let t = y0; while (t < y1 && !inRow(t)) t++;
    let b = y1; while (b > t && !inRow(b)) b--;
    while (t - 1 >= ey0 && inRow(t - 1)) t--;
    while (b + 1 <= ey1 && inRow(b + 1)) b++;
    let l = x0; while (l < x1 && !inCol(l)) l++;
    let r = x1; while (r > l && !inCol(r)) r--;
    // Up to one full-width character of gap still belongs to the line (CJK brackets sit far right).
    const gap = Math.max(3, Math.round((b - t + 1) * 0.75));
    for (let x = l - 1, run = 0; x >= ex0; x--) { if (inCol(x)) { l = x; run = 0; } else if (++run > gap) break; }
    for (let x = r + 1, run = 0; x <= ex1; x++) { if (inCol(x)) { r = x; run = 0; } else if (++run > gap) break; }
    fx0 = l; fy0 = t; fx1 = r; fy1 = b;
    // Count the text lines from the blank gaps between them, and measure their height and spacing.
    // Split at every blank row, then fold thin fragments (accents, dots, the strokes of 二)
    // into their neighbour. Lines of similar height always stay separate.
    let runs = [];
    for (let y = t; y <= b; y++) {
      if (rows[y - ey0] > 0) {
        const last = runs[runs.length - 1];
        if (last && y === last[1] + 1) last[1] = y; else runs.push([y, y]);
      }
    }
    const tallest = runs.reduce((mx, rr) => Math.max(mx, rr[1] - rr[0] + 1), 0);
    const thin = (rr) => rr[1] - rr[0] + 1 < tallest * 0.45;
    const folded = [];
    for (const rr of runs) {
      const last = folded[folded.length - 1];
      if (last && (thin(rr) || thin(last)) && rr[0] - last[1] - 1 <= tallest * 0.6) last[1] = rr[1];
      else folded.push([rr[0], rr[1]]);
    }
    runs = folded;
    const real = runs.filter((rr) => rr[1] - rr[0] >= 2);
    if (real.length) {
      const hs = real.map((rr) => rr[1] - rr[0] + 1).sort((p, q) => p - q);
      measured = { lines: real.length, lineH: hs[hs.length >> 1], pitch: real.length > 1 ? (real[real.length - 1][0] - real[0][0]) / (real.length - 1) : 0 };
    }
  }
  const glyphH = fy1 - fy0 + 1;
  const pad = 3;
  fx0 = Math.max(0, fx0 - pad); fy0 = Math.max(0, fy0 - pad); fx1 = Math.min(W - 1, fx1 + pad); fy1 = Math.min(H - 1, fy1 + pad);

  let fg = TR.length > 6 ? [median(TR), median(TG), median(TB)] : null;
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const flat = flatShare >= 0.5;
  const light = lum(bg) > 140;
  if (!fg || Math.abs(lum(fg) - lum(bg)) < 70) fg = light ? [20, 20, 24] : [245, 245, 240];
  if (!flat && !light) fg = [250, 248, 240];
  return { x0: fx0, y0: fy0, x1: fx1, y1: fy1, bg, fg, flat, light, dev: Math.round(flatShare * 100), glyphH, measured };
}

function plateFor(region, r) {
  const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.filter = r.light ? 'blur(8px) brightness(1.08) saturate(0.9)' : 'blur(7px) brightness(0.5) saturate(0.8)';
  x.drawImage(region.canvas, r.x0 - 12, r.y0 - 12, w + 24, h + 24, -12, -12, w + 24, h + 24);
  return c.toDataURL('image/jpeg', 0.82);
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

// Share of b's area that lies inside a.
function covers(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / (b.w * b.h || 1);
}

function register({ regionId, blocks: list }) {
  const region = regions.get(regionId);
  if (!region) return api.send('engine:blocks', { regionId, blocks: [], missing: true });
  const out = [];
  for (const b of list) {
    const rb = region.box;
    const bx = { x0: b.rel[0] * rb.w, y0: b.rel[1] * rb.h, x1: b.rel[2] * rb.w, y1: b.rel[3] * rb.h };
    const r = refine(region.image, bx);
    if (!r) continue;
    const box = { x: rb.x + r.x0, y: rb.y + r.y0, w: r.x1 - r.x0 + 1, h: r.y1 - r.y0 + 1 };
    // Lines and font size come from the pixels when they can be measured; the model's count is the fallback.
    const ml = r.measured;
    const lines = ml && ml.lines <= Math.max(1, b.lines || 1) * 2 + 1 ? ml.lines : Math.max(1, b.lines || 1);
    let fontPx = r.glyphH / (0.95 + (lines - 1) * 1.45);
    let lineHeight = lines > 1 ? 1.45 : 1.2;
    if (ml && ml.lines === lines) {
      fontPx = ml.lineH / (b.ext || 0.92);
      if (ml.pitch) {
        fontPx = Math.min(Math.max(fontPx, ml.pitch / 1.75), ml.pitch / 1.15);
        lineHeight = Math.min(1.8, Math.max(1.1, ml.pitch / fontPx));
      }
    }
    // A single line can't be much larger than the model's own box allows.
    if (lines === 1) fontPx = Math.min(fontPx, (bx.y1 - bx.y0) / (b.ext || 0.92) * 1.6);
    const style = {
      color: rgb(r.fg),
      fill: r.flat ? rgb(r.bg) : null,
      plate: r.flat ? null : plateFor(region, r),
      fontPx: Math.max(8, fontPx),
      lineHeight,
      shadow: !r.flat && !r.light,
    };
    const cells = cellsInBox(box);
    const snap = snapCells(region.lum, cells);
    let visible = true;
    const now = performance.now();
    for (let si = 0; si < cells.length; si++) {
      const i = cells[si];
      if (cursorMask[i]) continue;
      if (cellDiffSnap(snap, si, i, animUntil[i] >= now)) { visible = false; break; }
    }
    // A newer translation replaces older ones it overlaps heavily or mostly covers.
    for (const [oid, o] of blocks) {
      const overlap = iou(o.box, box) > 0.35 || covers(box, o.box) > 0.5;
      if (overlap && (visible || !o.visible)) { blocks.delete(oid); out.push({ id: oid, removed: true }); }
    }
    const id = ++blockSeq;
    blocks.set(id, { box, cells, snap, visible, data: b });
    // Region-relative box of the refined result, for the cache.
    const relRefined = [r.x0 / rb.w, r.y0 / rb.h, (r.x1 + 1) / rb.w, (r.y1 + 1) / rb.h];
    // Room to the right, inside the region, that a single line may grow into if it must.
    const maxW = rb.x + rb.w - box.x;
    out.push({ id, key: b.key, box, style, visible, relRefined, regionBox: rb, maxW, lines, dbg: { model: bx, bg: r.bg, dev: Math.round(r.dev), fg: r.fg, font: Math.round(style.fontPx * 10) / 10 } });
  }
  if (blocks.size > 400) {
    for (const [oid, o] of blocks) { if (!o.visible) { blocks.delete(oid); out.push({ id: oid, removed: true }); } if (blocks.size <= 300) break; }
  }
  api.send('engine:blocks', { regionId, blocks: out });
}

function snapshot({ reqId, maxWidth = 1280 }) {
  if (!video || !fw) return api.send('engine:snapshot', { reqId, error: 'no frame' });
  const s = Math.min(1, maxWidth / fw);
  const c = document.createElement('canvas'); c.width = Math.round(fw * s); c.height = Math.round(fh * s);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.88);
  api.send('engine:snapshot', { reqId, mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), width: c.width, height: c.height });
}

function reset() {
  if (!committedSet) return;
  committedSet.fill(0);
  const removed = [...blocks.keys()].map((id) => ({ id, removed: true }));
  blocks.clear();
  if (removed.length) api.send('engine:blocks', { regionId: 0, blocks: removed });
  startAt = performance.now() - WARMUP_MS;
}

api.on('engine:start', start);
api.on('engine:stop', stop);
api.on('engine:pause', (p) => { paused = !!p; });
api.on('engine:cursor', (p) => { cursorPos = p; });
api.on('engine:zones', (z) => { zones = z; buildZoneMask(); });
api.on('engine:config', (c) => {
  cfg = { ...cfg, ...c };
  if (timer) { clearInterval(timer); timer = setInterval(tick, Math.round(1000 / cfg.scanPerSecond)); }
});
api.on('engine:register', register);
api.on('engine:snapshot-req', snapshot);
api.on('engine:reset', reset);
api.on('engine:forget', ({ ids }) => { for (const id of ids) blocks.delete(id); });
// A failed request: mark its cells unhandled so the region is sent again once it is still settled.
api.on('engine:uncommit', ({ box }) => { if (committedSet) for (const i of cellsInBox(box)) committedSet[i] = 0; });
api.send('engine:ready', true);
