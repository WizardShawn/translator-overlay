'use strict';
// Win32 calls through koffi: window bounds, foreground, cursor, keys, process path.
const koffi = require('koffi');
const path = require('path');

const RECT = koffi.struct('TO_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const POINT = koffi.struct('TO_POINT', { x: 'int32', y: 'int32' });
const MONITORINFO = koffi.struct('TO_MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });

const user32 = koffi.load('user32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const kernel32 = koffi.load('kernel32.dll');

const fn = {
  GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
  IsWindow: user32.func('bool __stdcall IsWindow(intptr_t h)'),
  IsIconic: user32.func('bool __stdcall IsIconic(intptr_t h)'),
  IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t h)'),
  GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t h, _Out_ TO_RECT *r)'),
  GetClientRect: user32.func('bool __stdcall GetClientRect(intptr_t h, _Out_ TO_RECT *r)'),
  ClientToScreen: user32.func('bool __stdcall ClientToScreen(intptr_t h, _Inout_ TO_POINT *p)'),
  GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t h, _Out_ uint16_t *buf, int n)'),
  GetWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t h, _Out_ uint32 *pid)'),
  GetAsyncKeyState: user32.func('int16 __stdcall GetAsyncKeyState(int vk)'),
  GetCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ TO_POINT *p)'),
  GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t h, int idx)'),
  MonitorFromWindow: user32.func('intptr_t __stdcall MonitorFromWindow(intptr_t h, uint32 flags)'),
  GetMonitorInfoW: user32.func('bool __stdcall GetMonitorInfoW(intptr_t m, _Inout_ TO_MONITORINFO *mi)'),
  DwmGetWindowAttribute: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr_t h, uint32 attr, _Out_ TO_RECT *r, uint32 size)'),
  OpenProcess: kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
  CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr_t h)'),
  QueryFullProcessImageNameW: kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32 flags, _Out_ uint16_t *buf, _Inout_ uint32 *size)'),
};

const GWL_STYLE = -16;
const WS_CAPTION = 0x00C00000;
const WS_THICKFRAME = 0x00040000;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

const VK = { Alt: 0x12, Ctrl: 0x11, Shift: 0x10, CapsLock: 0x14, Tab: 0x09, Space: 0x20 };

function rectObj(r) { return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }; }

function hwndFromSourceId(id) {
  const m = /^window:(\d+):/.exec(id || '');
  return m ? Number(m[1]) : 0;
}

function isWindow(h) { return !!h && fn.IsWindow(h); }
function isMinimized(h) { return fn.IsIconic(h); }
function foreground() { return Number(fn.GetForegroundWindow()); }

// Visible bounds in physical screen pixels (no drop shadow). This matches what window capture returns.
function visibleBounds(h) {
  const r = {};
  if (fn.DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) === 0) return rectObj(r);
  const r2 = {};
  return fn.GetWindowRect(h, r2) ? rectObj(r2) : null;
}

function clientBounds(h) {
  const r = {};
  if (!fn.GetClientRect(h, r)) return null;
  const p = { x: 0, y: 0 };
  fn.ClientToScreen(h, p);
  return { x: p.x, y: p.y, width: r.right - r.left, height: r.bottom - r.top };
}

function title(h) {
  const buf = new Uint16Array(512);
  const n = fn.GetWindowTextW(h, buf, 512);
  return Buffer.from(buf.buffer, 0, n * 2).toString('utf16le');
}

function processPath(h) {
  const pid = [0];
  fn.GetWindowThreadProcessId(h, pid);
  if (!pid[0]) return { pid: 0, path: '' };
  const ph = fn.OpenProcess(0x1000, false, pid[0]);
  if (!ph) return { pid: pid[0], path: '' };
  try {
    const buf = new Uint16Array(1024);
    const len = [1024];
    if (!fn.QueryFullProcessImageNameW(ph, 0, buf, len)) return { pid: pid[0], path: '' };
    return { pid: pid[0], path: Buffer.from(buf.buffer, 0, len[0] * 2).toString('utf16le') };
  } finally { fn.CloseHandle(ph); }
}

function exeName(h) { return path.basename(processPath(h).path || ''); }

// How the window is displayed: 'borderless' (fills its monitor, no frame), 'windowed', or 'fullscreen-like'.
function displayMode(h) {
  const style = Number(fn.GetWindowLongPtrW(h, GWL_STYLE));
  const b = visibleBounds(h);
  const mon = fn.MonitorFromWindow(h, 2);
  const mi = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {}, rcWork: {}, dwFlags: 0 };
  fn.GetMonitorInfoW(mon, mi);
  const m = rectObj(mi.rcMonitor);
  const fills = b && b.x <= m.x && b.y <= m.y && b.x + b.width >= m.x + m.width && b.y + b.height >= m.y + m.height;
  const framed = (style & WS_CAPTION) === WS_CAPTION || (style & WS_THICKFRAME) !== 0;
  if (fills && !framed) return { mode: 'borderless', monitor: m };
  if (fills) return { mode: 'maximized', monitor: m };
  return { mode: 'windowed', monitor: m };
}

function keyDown(name) {
  const vk = VK[name] || (typeof name === 'number' ? name : 0);
  return vk ? (fn.GetAsyncKeyState(vk) & 0x8000) !== 0 : false;
}

function cursor() { const p = {}; fn.GetCursorPos(p); return { x: p.x, y: p.y }; }

module.exports = {
  hwndFromSourceId, isWindow, isMinimized, foreground, visibleBounds, clientBounds,
  title, processPath, exeName, displayMode, keyDown, cursor,
};
