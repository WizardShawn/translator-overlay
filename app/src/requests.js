'use strict';
// Builds the bodies for the three Gemini calls.
const { loadPrompt, languageName } = require('./config');

const BLOCK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    blocks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          region: { type: 'INTEGER' },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
          kind: { type: 'STRING', enum: ['dialogue', 'name', 'choice', 'menu', 'label', 'other'] },
          lines: { type: 'INTEGER' },
          align: { type: 'STRING', enum: ['left', 'center', 'right'] },
          source: { type: 'STRING' },
          text: { type: 'STRING' },
          speaker: { type: 'STRING', nullable: true },
          confidence: { type: 'STRING', enum: ['high', 'low'] },
          note: { type: 'STRING', nullable: true },
        },
        required: ['region', 'box_2d', 'kind', 'lines', 'source', 'text', 'confidence'],
        propertyOrdering: ['region', 'box_2d', 'kind', 'lines', 'align', 'source', 'text', 'speaker', 'confidence', 'note'],
      },
    },
    new_terms: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          source: { type: 'STRING' }, target: { type: 'STRING' }, kind: { type: 'STRING' },
        },
        required: ['source', 'target'],
      },
    },
  },
  required: ['blocks'],
  propertyOrdering: ['blocks', 'new_terms'],
};

function profileText(profile) {
  if (!profile || (!profile.setting && !(profile.characters || []).length)) {
    return 'GAME PROFILE:\nNo profile yet. Infer setting and voices from the screen and recent dialogue.';
  }
  const p = profile;
  const lines = ['GAME PROFILE:'];
  const t = p.titles || {};
  if (t.original || t.romanized) lines.push(`Title: ${[t.original, t.romanized && `(${t.romanized})`, t.target && `, known in the target language as ${t.target}`].filter(Boolean).join(' ')}`);
  if (p.genre) lines.push(`Genre: ${p.genre}`);
  if (p.tone) lines.push(`Tone: ${p.tone}`);
  if (p.setting) lines.push(`Setting: ${p.setting}`);
  if ((p.characters || []).length) {
    lines.push('Characters:');
    for (const c of p.characters) {
      const bits = [`${c.source}${c.reading ? ` (${c.reading})` : ''} -> ${c.target || c.source}`];
      if (c.role) bits.push(c.role);
      if (c.gender) bits.push(c.gender);
      if (c.speech) bits.push(`speaks: ${c.speech}`);
      lines.push(`- ${bits.join('; ')}`);
    }
  }
  if ((p.style_rules || []).length) {
    lines.push('Style rules:');
    for (const r of p.style_rules) if (r) lines.push(`- ${r}`);
  }
  if ((p.style_examples || []).length) {
    lines.push('Approved translations to imitate:');
    for (const e of p.style_examples.slice(-12)) lines.push(`- ${e.speaker ? e.speaker + ': ' : ''}${e.source} => ${e.text}`);
  }
  return lines.join('\n');
}

function glossaryText(profile) {
  const g = (profile && profile.glossary) || [];
  if (!g.length) return 'GLOSSARY:\n(empty)';
  return 'GLOSSARY:\n' + g.map((t) => `- ${t.source} => ${t.keep ? `${t.source} (keep)` : t.target}${t.note ? ` [${t.note}]` : ''}`).join('\n');
}

function recentText(lines) {
  if (!lines.length) return 'RECENT DIALOGUE:\n(none yet)';
  return 'RECENT DIALOGUE:\n' + lines.map((l) => `- ${l.speaker ? l.speaker : (l.kind === 'choice' ? '[choice]' : '[narration]')}: ${l.source} => ${l.text}`).join('\n');
}

// regions: [{ index, width, height, mime, data }]
function translateBody({ settings, profile, recent, regions }) {
  const parts = [
    { text: profileText(profile) },
    { text: glossaryText(profile) },
    { text: recentText(recent) },
  ];
  for (const r of regions) {
    parts.push({ text: `Region ${r.index} (${r.width}x${r.height} px)` });
    parts.push({ inlineData: { mimeType: r.mime, data: r.data } });
  }
  const gc = {
    temperature: settings.translate.temperature,
    responseMimeType: 'application/json',
    responseSchema: BLOCK_SCHEMA,
  };
  const level = settings.translate.thinking_level;
  if (level) gc.thinkingConfig = { thinkingLevel: level };
  return {
    systemInstruction: { parts: [{ text: loadPrompt('translate', settings) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: gc,
  };
}

function identifyBody({ settings, info, screenText, screenshot }) {
  const parts = [
    { text: `WINDOW: ${info.title || ''}` },
    { text: `EXECUTABLE: ${info.exeName || ''}; product name: ${info.version?.ProductName || ''}; company: ${info.version?.CompanyName || ''}; description: ${info.version?.FileDescription || ''}; version: ${info.version?.ProductVersion || ''}` },
    { text: `SCREEN TEXT:\n${screenText.length ? screenText.map((s) => '- ' + s).join('\n') : '(none read yet)'}` },
    { text: `LANGUAGES: game ${languageName(settings.languages.source)}, player ${languageName(settings.languages.target)}` },
  ];
  if (screenshot) { parts.push({ text: 'SCREENSHOT:' }); parts.push({ inlineData: { mimeType: screenshot.mime, data: screenshot.data } }); }
  const body = {
    systemInstruction: { parts: [{ text: loadPrompt('profile_identify', settings) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.3 },
  };
  if (settings.profile.use_web_search) body.tools = [{ google_search: {} }];
  return body;
}

function updateBody({ settings, profile, transcript, pendingTerms, newSpeakers }) {
  const parts = [
    { text: 'PROFILE:\n' + JSON.stringify(profile, null, 1) },
    { text: 'TRANSCRIPT:\n' + transcript.map((l) => `- ${l.speaker || '[' + l.kind + ']'}: ${l.source} => ${l.text}`).join('\n') },
    { text: 'PENDING TERMS:\n' + (pendingTerms.length ? pendingTerms.map((t) => `- ${t.source} => ${t.target}`).join('\n') : '(none)') },
    { text: 'NEW SPEAKERS:\n' + (newSpeakers.length ? newSpeakers.join(', ') : '(none)') },
  ];
  return {
    systemInstruction: { parts: [{ text: loadPrompt('profile_update', settings) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };
}

module.exports = { translateBody, identifyBody, updateBody, profileText, glossaryText, recentText };
