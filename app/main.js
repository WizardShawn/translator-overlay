'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, session: esession, screen, globalShortcut, dialog, nativeTheme, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const config = require('./src/config');
const win32 = require('./src/win32');
const { GameStore, gameIdFor, listGames } = require('./src/store');
const { Session } = require('./src/session');

const argv = process.argv.slice(1);
const flag = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const flagValue = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const DEBUG_VISIBLE = flag('debug-visible');        // overlay shows in screenshots
const DEBUG_ALWAYS = flag('debug-always-show');     // overlay stays up when the game is not in front
const AUTO_START = flagValue('start');
const DEBUG_DUMP = flag('debug-dump');              // write region crops and block details to data/debug              // start on the first window whose title contains this

const LOG_FILE = path.join(config.DATA_DIR, 'app.log');
fs.mkdirSync(config.DATA_DIR, { recursive: true });
function log(...a) {
  try { if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch { /* new file */ }
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
}

process.on('unhandledRejection', (e) => log('unhandled', e && e.stack || String(e)));
process.on('uncaughtException', (e) => log('uncaught', e && e.stack || String(e)));
if (!app.requestSingleInstanceLock()) { app.quit(); }
nativeTheme.themeSource = 'dark';
app.setName('Translator Overlay');
if (process.platform === 'win32') app.setAppUserModelId('TranslatorOverlay.App');

let control = null, engine = null, overlay = null;
let sess = null, current = null;      // current = { source, hwnd, store, game, bounds, frame }
let pollTimer = null, overlayShown = false, peeking = false, editingZones = false;
let engineReady = null;
const snapshotWaits = new Map();
let snapSeq = 0;

const preload = path.join(__dirname, 'preload.js');
const send = (w, ch, d) => { if (w && !w.isDestroyed()) w.webContents.send(ch, d); };
let statusTimer = null, statusQueued = null;
function toUi(ch, d) {
  if (ch === 'session:status') {
    statusQueued = d;
    if (!statusTimer) statusTimer = setTimeout(() => { statusTimer = null; send(control, 'session:status', statusQueued); }, 250);
    return;
  }
  send(control, ch, d);
}

/* ---------- windows ---------- */
function createControl() {
  control = new BrowserWindow({
    width: 1240, height: 840, minWidth: 900, minHeight: 600, backgroundColor: '#14171d', show: false,
    title: 'Translator Overlay', autoHideMenuBar: true,
    icon: path.join(__dirname, 'ui', 'icon.ico'),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  control.loadFile(path.join(__dirname, 'ui', 'index.html'));
  control.once('ready-to-show', () => { if (!flag('hidden')) control.show(); });
  control.on('closed', () => { control = null; app.quit(); });
}

function createEngine() {
  engine = new BrowserWindow({
    show: false, width: 400, height: 300,
    webPreferences: { preload, contextIsolation: true, backgroundThrottling: false },
  });
  engineReady = new Promise((res) => ipcMain.once('engine:ready', () => res()));
  engine.webContents.on('console-message', (e) => log('engine console', e.level, e.message, e.lineNumber));
  engine.webContents.on('preload-error', (_e, p, err) => log('engine preload error', err.message));
  engine.loadFile(path.join(__dirname, 'engine', 'engine.html'));
}

function createOverlay() {
  overlay = new BrowserWindow({
    transparent: true, frame: false, resizable: false, movable: false, focusable: false, skipTaskbar: true,
    hasShadow: false, alwaysOnTop: true, show: false, backgroundColor: '#00000000', title: 'Translator Overlay layer',
    webPreferences: { preload, contextIsolation: true, backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlay.setContentProtection(!DEBUG_VISIBLE);
  overlay.webContents.on('console-message', (e) => log('overlay console', e.level, e.message, e.lineNumber));
  overlay.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  overlay.on('closed', () => { overlay = null; overlayShown = false; });
}

function overlayHwnd() {
  if (!overlay) return 0;
  const b = overlay.getNativeWindowHandle();
  return Number(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0));
}

/* ---------- capture source ---------- */
let currentSource = null;
function ownWindowIds() {
  return new Set(BrowserWindow.getAllWindows().map((w) => { const b = w.getNativeWindowHandle(); return Number(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0)); }));
}

async function listWindows() {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
  const own = ownWindowIds();
  const out = [];
  for (const s of sources) {
    const hwnd = win32.hwndFromSourceId(s.id);
    if (!hwnd || own.has(hwnd) || !win32.isWindow(hwnd)) continue;
    const b = win32.visibleBounds(hwnd);
    if (!b || b.width < 320 || b.height < 200) continue;
    const proc = win32.processPath(hwnd);
    const exe = path.basename(proc.path || '');
    if (/^(explorer|textinputhost|shellexperiencehost|searchhost|startmenuexperiencehost|systemsettings|nvidia overlay|gamebar|gamebarftserver|discordoverlay)\.exe$/i.test(exe)) continue;
    const id = gameIdFor(exe, s.name);
    const mode = win32.displayMode(hwnd).mode;
    out.push({
      sourceId: s.id, hwnd, title: s.name, exe, exePath: proc.path, bounds: b, mode, gameId: id,
      known: fs.existsSync(path.join(config.DATA_DIR, 'games', id, 'game.json')),
      thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
    });
  }
  return out;
}

/* ---------- sessions ---------- */
async function startSession(sourceId) {
  stopSession('switch');
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  const source = sources.find((s) => s.id === sourceId);
  if (!source) throw new Error('That window is gone. Pick the game again.');
  const hwnd = win32.hwndFromSourceId(sourceId);
  const proc = win32.processPath(hwnd);
  const exe = path.basename(proc.path || '');
  const title = win32.title(hwnd) || source.name;
  const gameId = gameIdFor(exe, title);
  const store = new GameStore(gameId);
  const now = new Date().toISOString();
  const meta = store.meta;
  store.saveMeta({ title, exe, exe_path: proc.path, last_played: now, first_played: meta.first_played || now });
  const settings = config.loadSettings();
  config.getKey();   // fail early when the key cannot be read

  currentSource = source;
  current = { source, hwnd, store, game: { id: gameId, title, exe, exePath: proc.path, hwnd }, bounds: null, frame: null };
  if (!overlay) createOverlay();
  await new Promise((r) => (overlay.webContents.isLoading() ? overlay.webContents.once('did-finish-load', r) : r()));
  send(overlay, 'overlay:clear');
  sendOverlayMode(settings);

  sess = new Session({
    store, game: current.game, settings,
    engine: (ch, d) => send(engine, ch, d),
    overlay: (ch, d) => send(overlay, ch, d),
    ui: toUi,
    snapshot: () => new Promise((resolve, reject) => {
      const reqId = ++snapSeq;
      snapshotWaits.set(reqId, { resolve, reject });
      send(engine, 'engine:snapshot-req', { reqId, maxWidth: 1280 });
      setTimeout(() => { if (snapshotWaits.delete(reqId)) reject(new Error('snapshot timeout')); }, 5000);
    }),
  });
  await engineReady;
  send(engine, 'engine:start', { cfg: engineCfg(settings), zones: store.zones });
  startPolling();
  sess.pushStatus();
  log('session start', { gameId, title, exe, sourceId });
  toUi('app:session', { running: true, game: current.game });
  return current.game;
}

function stopSession(reason) {
  if (!sess) return;
  log('session stop', reason || '');
  send(engine, 'engine:stop');
  sess.dispose();
  sess = null; current = null; currentSource = null;
  stopPolling();
  if (overlay) { send(overlay, 'overlay:clear'); overlay.hide(); overlayShown = false; }
  toUi('app:session', { running: false, reason });
}

function engineCfg(s) {
  return { scanPerSecond: s.translate.scan_per_second, stableMs: s.translate.stable_wait_ms, maxImageWidth: s.translate.max_image_width };
}
function sendOverlayMode(s) {
  send(overlay, 'overlay:mode', { mode: s.display.mode, minFontPx: s.display.min_font_px, fontFamily: s.display.font_family, showHud: s.display.show_hud, debug: DEBUG_DUMP });
}

function setPaused(p) {
  if (!sess) return;
  sess.paused = p;
  send(engine, 'engine:pause', p);
  sess.pushStatus();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, 80);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

function poll() {
  if (!current || !overlay) return;
  const h = current.hwnd;
  if (!win32.isWindow(h)) { stopSession('The game window closed.'); return; }
  const b = win32.visibleBounds(h);
  if (b && (!current.bounds || b.x !== current.bounds.x || b.y !== current.bounds.y || b.width !== current.bounds.width || b.height !== current.bounds.height)) {
    current.bounds = b;
    const dip = screen.screenToDipRect(null, b);
    overlay.setBounds({ x: Math.round(dip.x), y: Math.round(dip.y), width: Math.round(dip.width), height: Math.round(dip.height) });
  }
  const fg = win32.foreground();
  const show = !win32.isMinimized(h) && !sess.paused && (DEBUG_ALWAYS || editingZones || fg === h || fg === overlayHwnd());
  if (show && !overlayShown) { overlay.showInactive(); overlay.setAlwaysOnTop(true, 'screen-saver'); overlayShown = true; }
  else if (!show && overlayShown) { overlay.hide(); overlayShown = false; }

  if (current.frame && b) {
    const c = win32.cursor();
    const inside = c.x >= b.x && c.y >= b.y && c.x < b.x + b.width && c.y < b.y + b.height;
    send(engine, 'engine:cursor', inside ? { x: (c.x - b.x) * current.frame.width / b.width, y: (c.y - b.y) * current.frame.height / b.height } : null);
  }
  const peek = show && win32.keyDown(sess.settings.display.peek_key || 'Alt');
  if (peek !== peeking) { peeking = peek; send(overlay, 'overlay:peek', peek); }
}

/* ---------- engine messages ---------- */
ipcMain.on('engine:frame', (_e, f) => {
  if (!current) return;
  current.frame = f;
  if (sess) sess.shown.clear();
  send(overlay, 'overlay:clear');
  send(overlay, 'overlay:frame', f);
  log('frame', f, 'bounds', current.bounds);
});
ipcMain.on('engine:regions', (_e, regions) => {
  if (!sess || sess.paused) return;
  if (DEBUG_DUMP) log('regions', regions.map((r) => ({ id: r.regionId, box: r.box, size: `${r.width}x${r.height}`, kb: Math.round(r.data.length * 0.75 / 1024) })));
  if (DEBUG_DUMP) {
    const dir = path.join(config.DATA_DIR, 'debug'); fs.mkdirSync(dir, { recursive: true });
    for (const r of regions) fs.writeFileSync(path.join(dir, `region-${r.regionId}.webp`), Buffer.from(r.data, 'base64'));
  }
  sess.onRegions(regions);
});
ipcMain.on('engine:blocks', (_e, d) => {
  if (!sess) return;
  sess.onEngineBlocks(d);
  if (DEBUG_DUMP) log('blocks', d.regionId, d.blocks.filter((b) => !b.removed).map((b) => ({ id: b.id, box: b.box, visible: b.visible, ...(DEBUG_DUMP ? { dbg: b.dbg, fill: b.style.fill, plate: !!b.style.plate } : {}) })));
});
ipcMain.on('engine:visibility', (_e, list) => { if (sess) sess.onVisibility(list); });
ipcMain.on('engine:status', (_e, s) => { if (sess) { sess.engineStatus = s; sess.pushStatus(); } });
ipcMain.on('engine:error', (_e, m) => { log('engine error', m); toUi('session:error', { short: 'Capture failed', message: m }); });
ipcMain.on('engine:log', (_e, m) => log('engine', m));
ipcMain.on('engine:snapshot', (_e, d) => {
  const w = snapshotWaits.get(d.reqId);
  if (!w) return;
  snapshotWaits.delete(d.reqId);
  d.error ? w.reject(new Error(d.error)) : w.resolve({ mime: d.mime, data: d.data });
});

/* ---------- overlay messages ---------- */
function beginZones() {
  if (!current || !overlay) return;
  editingZones = true;
  overlay.setFocusable(true);
  overlay.setIgnoreMouseEvents(false);
  overlay.showInactive(); overlayShown = true;
  overlay.focus();
  send(overlay, 'overlay:zones', current.store.zones);
}
ipcMain.on('overlay:zones-save', (_e, z) => {
  editingZones = false;
  if (overlay) { overlay.setIgnoreMouseEvents(true); overlay.setFocusable(false); }
  send(overlay, 'overlay:zones', null);
  if (z && current) {
    current.store.saveZones(z);
    send(engine, 'engine:zones', z);
    toUi('zones:changed', z);
  }
});

/* ---------- control panel API ---------- */
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, arg) => {
    try { return { ok: true, value: await fn(arg) }; } catch (e) { log('ipc error', ch, e.message); return { ok: false, error: e.message }; }
  });
}

handle('app:state', () => {
  const settings = config.loadSettings();
  return {
    settings, key: config.keyInfo(settings), session: sess ? sess.statusPayload() : null,
    game: current ? current.game : null, languages: config.LANGUAGE_NAMES, dataDir: config.DATA_DIR,
    debug: { visible: DEBUG_VISIBLE, always: DEBUG_ALWAYS },
  };
});
handle('windows:list', listWindows);
handle('library:list', () => listGames());
handle('overlay:start', ({ sourceId }) => startSession(sourceId));
handle('overlay:stop', () => stopSession('Stopped from the app.'));
handle('overlay:pause', (p) => setPaused(p === undefined ? !(sess && sess.paused) : !!p));
handle('overlay:retranslate', () => retranslate());
handle('zones:edit', () => beginZones());
handle('profile:get', ({ gameId }) => {
  const store = new GameStore(gameId);
  return { meta: store.meta, profile: store.profile, zones: store.zones, status: sess && current && current.game.id === gameId ? sess.profileStatus : null };
});
handle('profile:save', ({ gameId, profile }) => {
  const store = new GameStore(gameId);
  const saved = store.saveProfile(profile);
  if (sess && current && current.game.id === gameId) sess.setProfile(saved);
  return saved;
});
handle('profile:draft', ({ gameId }) => {
  if (!sess || current.game.id !== gameId) throw new Error('Start the overlay on this game first. The draft reads its title screen.');
  sess.identify();
  return true;
});
handle('session:transcript', ({ gameId } = {}) => {
  if (sess && (!gameId || current.game.id === gameId)) return { lines: sess.transcript, terms: sess.pendingTerms, conflicts: sess.conflicts };
  if (gameId) return { lines: new GameStore(gameId).readTranscript(400), terms: [], conflicts: [] };
  return { lines: [], terms: [], conflicts: [] };
});
handle('session:edit', ({ id, text, asExample }) => { if (!sess) throw new Error('No session running.'); sess.editLine(id, text, asExample); return true; });
handle('terms:review', ({ source, target }) => { if (!sess) throw new Error('No session running.'); sess.reviewTerm(source, target); return true; });
handle('settings:save', (patch) => {
  const s = config.saveSettings(patch);
  if (sess) sess.reloadSettings();
  send(engine, 'engine:config', engineCfg(s));
  sendOverlayMode(s);
  registerHotkeys(s);
  return s;
});
handle('key:replace', () => new Promise((resolve) => {
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', path.join(config.CONFIG_DIR, 'set-gemini-key.ps1')], { windowsHide: true });   // the key form still shows; no console window behind it
  p.on('exit', () => { config.forgetKey(); resolve(config.keyInfo(config.loadSettings())); });
}));
handle('transcript:export', async ({ gameId }) => {
  const store = new GameStore(gameId);
  const lines = sess && current.game.id === gameId ? sess.transcript : store.readTranscript(100000);
  const r = await dialog.showSaveDialog(control, {
    title: 'Export transcript', defaultPath: path.join(app.getPath('documents'), `${gameId}-transcript.txt`),
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const body = lines.map((l) => `[${new Date(l.t).toLocaleString()}] ${l.speaker ? l.speaker + ': ' : ''}${l.source}\n    ${l.text}`).join('\n\n');
  fs.writeFileSync(r.filePath, body + '\n', 'utf8');
  return r.filePath;
});
handle('folder:open', (which) => shell.openPath(which === 'config' ? config.CONFIG_DIR : config.DATA_DIR));
handle('models:list', () => {
  try {
    return fs.readFileSync(path.join(config.CONFIG_DIR, 'available-models.txt'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  } catch { return []; }
});

/* ---------- hotkeys ---------- */
function retranslate() {
  if (!sess) return;
  sess.retranslate();
  sess.shown.clear();
  send(overlay, 'overlay:clear');
  send(engine, 'engine:reset');
}
async function toggle() {
  if (sess) { setPaused(!sess.paused); return; }
  const fg = win32.foreground();
  if (!fg || ownWindowIds().has(fg)) { control && control.show(); return; }
  const list = await listWindows();
  const w = list.find((x) => x.hwnd === fg);
  if (w) startSession(w.sourceId).catch((e) => toUi('session:error', { short: 'Could not start', message: e.message }));
}
function registerHotkeys(s) {
  globalShortcut.unregisterAll();
  const map = [
    [s.hotkeys.toggle, toggle],
    [s.hotkeys.retranslate, retranslate],
    [s.hotkeys.show_log, () => { if (control) { control.show(); control.focus(); send(control, 'ui:navigate', 'session'); } }],
    [s.hotkeys.zones, beginZones],
  ];
  for (const [acc, fn] of map) {
    if (!acc) continue;
    try { if (!globalShortcut.register(acc, fn)) log('hotkey taken', acc); } catch (e) { log('hotkey invalid', acc, e.message); }
  }
}

/* ---------- app lifecycle ---------- */
app.whenReady().then(async () => {
  esession.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    if (currentSource) cb({ video: currentSource }); else cb({});
  });
  createEngine();
  createControl();
  registerHotkeys(config.loadSettings());
  log('app start', { argv });
  if (AUTO_START) {
    await engineReady;
    for (let i = 0; i < 20 && !sess; i++) {
      let list = [];
      try { list = await listWindows(); } catch (e) { log('listWindows failed', e.stack); }
      if (i === 0) log('windows', list.map((x) => x.title));
      const w = list.find((x) => x.title.includes(AUTO_START));
      if (w) { await startSession(w.sourceId).catch((e) => log('auto start failed', e.message)); break; }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
});
// Debug: --debug-ui-shots=<dir>[,<delaySeconds>] saves a picture of each control-panel page, then quits.
const UI_SHOTS = flagValue('debug-ui-shots');
if (UI_SHOTS) {
  app.whenReady().then(async () => {
    const [dir, delay] = UI_SHOTS.split(',');
    fs.mkdirSync(dir, { recursive: true });
    await new Promise((r) => setTimeout(r, (Number(delay) || 30) * 1000));
    if (control) { control.setSize(1280, 900); control.showInactive(); }
    for (const page of ['games', 'profile', 'session', 'settings']) {
      send(control, 'ui:navigate', page);
      await new Promise((r) => setTimeout(r, 2500));
      const img = await control.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `ui-${page}.png`), img.toPNG());
    }
    log('ui shots saved', dir);
    if (flag('debug-quit')) app.quit();
  });
}

app.on('second-instance', () => { if (control) { control.show(); control.focus(); } });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (sess) sess.dispose(); });
app.on('window-all-closed', () => app.quit());
