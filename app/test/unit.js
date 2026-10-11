'use strict';
// Unit tests for the parts that do not need a screen or the network. Run: npm test
const assert = require('assert');
const { BlockStream, parseLooseJson } = require('../src/blockstream');
const { gameIdFor, hamming } = require('../src/store');
const { translateBody, profileText, glossaryText } = require('../src/requests');
const { loadSettings } = require('../src/config');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '\n     ', e.message); process.exitCode = 1; }
}

test('stream emits each block as soon as it closes, across chunk boundaries', () => {
  const got = [];
  const bs = new BlockStream((k, o) => got.push([k, o]));
  const reply = JSON.stringify({
    blocks: [
      { region: 1, box_2d: [1, 2, 3, 4], kind: 'dialogue', source: '「括弧 {braces} and \\"quotes\\"」', text: 'a "b" }' },
      { region: 2, box_2d: [5, 6, 7, 8], kind: 'name', source: '湊', text: '凑' },
    ],
    new_terms: [{ source: '夜渡り', target: '夜渡' }],
  });
  for (let i = 0; i < reply.length; i += 7) bs.push(reply.slice(i, i + 7));
  assert.strictEqual(got.length, 3);
  assert.strictEqual(got[0][0], 'blocks');
  assert.strictEqual(got[0][1].text, 'a "b" }');
  assert.strictEqual(got[1][1].source, '湊');
  assert.deepStrictEqual(got[2], ['new_terms', { source: '夜渡り', target: '夜渡' }]);
});

test('stream ignores an unfinished last block', () => {
  const got = [];
  const bs = new BlockStream((k, o) => got.push(o));
  bs.push('{"blocks":[{"region":1,"text":"done"},{"region":2,"text":"half');
  assert.strictEqual(got.length, 1);
});

test('loose JSON parse strips code fences and prose', () => {
  assert.deepStrictEqual(parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(parseLooseJson('Here you go: {"a":2} hope it helps'), { a: 2 });
  assert.strictEqual(parseLooseJson('no json'), null);
});

test('game ids: real games by exe, browser-hosted games by exe and title', () => {
  assert.strictEqual(gameIdFor('Hitomori.exe', 'Anything'), 'hitomori');
  assert.strictEqual(gameIdFor('chrome.exe', '灯守の町'), 'chrome-灯守の町');
  assert.ok(!/[<>:"/\\|?*]/.test(gameIdFor('javaw.exe', 'a/b:c*?')));
});

test('hamming distance on hex hashes', () => {
  assert.strictEqual(hamming('00', '00'), 0);
  assert.strictEqual(hamming('0f', '00'), 4);
  assert.strictEqual(hamming('ff', 'f'), Infinity);
});

test('translate request: profile, glossary, dialogue, then numbered images; thinking set', () => {
  const settings = loadSettings();
  const profile = {
    titles: { original: '灯守の町' }, setting: 'A riverside town.',
    characters: [{ source: '湊', target: '凑', speech: 'casual' }],
    glossary: [{ source: '夜渡り', target: '夜渡' }, { source: 'HP', keep: true }],
  };
  const body = translateBody({
    settings, profile,
    recent: [{ speaker: '湊', kind: 'dialogue', source: 'おかえり', text: '欢迎回来' }],
    regions: [{ index: 1, width: 10, height: 10, mime: 'image/webp', data: 'AAAA' }, { index: 2, width: 5, height: 5, mime: 'image/webp', data: 'BBBB' }],
  });
  const parts = body.contents[0].parts;
  assert.ok(parts[0].text.startsWith('GAME PROFILE:'));
  assert.ok(parts[1].text.includes('夜渡り => 夜渡') && parts[1].text.includes('HP => HP (keep)'));
  assert.ok(parts[2].text.includes('湊: おかえり => 欢迎回来'));
  assert.strictEqual(parts[3].text, 'Region 1 (10x10 px)');
  assert.strictEqual(parts[4].inlineData.data, 'AAAA');
  assert.strictEqual(parts[5].text, 'Region 2 (5x5 px)');
  assert.ok(body.systemInstruction.parts[0].text.includes(require('../src/config').languageName(settings.languages.target)));
  assert.ok(!body.systemInstruction.parts[0].text.includes('{{'));
  assert.strictEqual(body.generationConfig.responseMimeType, 'application/json');
});

test('empty profile still tells the model what to do', () => {
  assert.ok(profileText(null).includes('No profile yet'));
  assert.ok(glossaryText(null).includes('(empty)'));
});

test('settings merge keeps defaults for keys missing from the file', () => {
  const s = loadSettings();
  assert.ok(s.display && s.hotkeys && s.translate.stable_wait_ms > 0);
  assert.ok(Array.isArray(s.models.translate_fallbacks));
});

console.log(`\n${passed} passed`);
