// Renders blocks in the real overlay page (headless Chrome) and reports how each one was fitted.
// Usage: npm run test:overlay   (drives the Google Chrome installed on this PC through playwright-core)
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');

const cases = [
  { name: 'dialogue line, CJK translation slightly wider than the box', block: { id: 1, kind: 'dialogue', lines: 1, align: 'left', lang: 'zh-Hans', maxW: 1100,
    box: { x: 128, y: 579, w: 564, h: 31 }, style: { fontPx: 27.8, lineHeight: 1.2, color: 'rgb(240,240,240)', fill: 'rgb(19,26,51)' },
    text: '“阔别七年了啊。……这座桥，原来有这么短吗？”' }, expectMinPx: 22 },
  { name: 'short label that must widen', block: { id: 2, kind: 'menu', lines: 1, align: 'left', lang: 'zh-Hans', maxW: 400,
    box: { x: 40, y: 100, w: 80, h: 20 }, style: { fontPx: 14, color: 'rgb(30,30,30)', fill: 'rgb(250,250,250)' },
    text: '游戏迁移到局域网桌面' }, expectMinPx: 12 },
  { name: 'three-line paragraph', block: { id: 3, kind: 'dialogue', lines: 3, align: 'left', lang: 'zh-Hans', maxW: 800,
    box: { x: 400, y: 200, w: 760, h: 70 }, style: { fontPx: 16, lineHeight: 1.5, color: 'rgb(30,30,30)', fill: 'rgb(250,250,250)' },
    text: '我发现 Gemini 在多行段落上多算了行数，导致字体被不必要地缩小。我将改为根据像素间距自行计算行数，测量实际的行高和间距，仅在需要时才回退使用 Gemini 的计数。' }, expectMinPx: 13 },
];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1266, height: 752 } });
  await page.addInitScript(() => {
    const handlers = {};
    window.api = { on: (ch, cb) => { handlers[ch] = cb; }, send: () => {}, invoke: async () => ({ ok: true }) };
    window.__emit = (ch, d) => handlers[ch] && handlers[ch](d);
  });
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'overlay', 'overlay.html')).href);
  await page.evaluate(() => { window.__emit('overlay:frame', { width: 1266, height: 752 }); window.__emit('overlay:mode', { mode: 'replace', minFontPx: 14 }); });
  let failed = 0;
  for (const c of cases) {
    const r = await page.evaluate((b) => {
      window.__emit('overlay:paint', [{ ...b, visible: true }]);
      const el = [...document.querySelectorAll('.patch')].pop();
      const span = el.firstChild;
      return { font: parseFloat(span.style.fontSize), w: el.clientWidth, h: el.clientHeight, spanW: span.scrollWidth, spanH: span.scrollHeight, ws: span.style.whiteSpace };
    }, c.block);
    const ok = r.font >= c.expectMinPx && r.spanW <= r.w + 1 && r.spanH <= r.h + 1;
    if (!ok) failed++;
    console.log(ok ? 'ok  ' : 'FAIL', c.name, JSON.stringify(r));
  }
  await page.screenshot({ path: path.join(process.env.TEMP, 'overlay-fit.png') });
  await browser.close();
  process.exitCode = failed ? 1 : 0;
})();
