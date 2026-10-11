'use strict';
// Live check of the translate call against Gemini. Usage: node test/api-probe.js [fixture] [thinkingLevel]
const fs = require('fs');
const path = require('path');
const { loadSettings, getKey } = require('../src/config');
const { translateBody } = require('../src/requests');
const gemini = require('../src/gemini');
const { BlockStream } = require('../src/blockstream');

(async () => {
  const fixture = process.argv[2] || 'dialogue-raw';
  const level = process.argv[3];
  const settings = loadSettings();
  if (process.argv[4]) settings.models.translate = process.argv[4];
  if (level !== undefined) settings.translate.thinking_level = level === 'none' ? '' : level;
  const img = fs.readFileSync(path.join(__dirname, 'fixtures', fixture + '.png'));
  const body = translateBody({
    settings, profile: null, recent: [],
    regions: [{ index: 1, width: 1218, height: 686, mime: 'image/png', data: img.toString('base64') }],
  });
  const t0 = Date.now();
  const firstBlockAt = [];
  const bs = new BlockStream((k, o) => { if (k === 'blocks') firstBlockAt.push(Date.now() - t0); });
  const r = await gemini.stream({ key: getKey(), model: settings.models.translate, body, onText: (t) => bs.push(t) });
  const out = JSON.parse(r.text);
  console.log(JSON.stringify({ model: settings.models.translate, thinking: settings.translate.thinking_level, ms: r.ms, firstTextMs: r.firstMs, blockTimes: firstBlockAt, usage: r.usage, finish: r.finish }, null, 1));
  for (const b of out.blocks) console.log(b.kind, JSON.stringify(b.box_2d), b.lines, '|', b.source, '=>', b.text, b.speaker ? `(${b.speaker})` : '');
  fs.writeFileSync(path.join(__dirname, 'fixtures', `${fixture}.result.json`), JSON.stringify(out, null, 1));
})().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; });
