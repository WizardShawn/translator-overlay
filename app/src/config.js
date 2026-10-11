'use strict';
// Paths, settings, prompts and the Gemini key.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');        // the folder that holds app/, config/ and data/
const CONFIG_DIR = path.join(ROOT, 'config');
const DATA_DIR = path.join(ROOT, 'data');

const DEFAULTS = {
  provider: 'gemini',
  key_file: 'gemini-key.dpapi.json',
  models: { translate: 'gemini-3.8-flash', translate_fallbacks: ['gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'], profile: 'gemini-pro-latest' },
  languages: { source: 'auto', target: 'en' },
  prompts: {
    translate: 'translator-prompt.md',
    profile_identify: 'profile-identify-prompt.md',
    profile_update: 'profile-update-prompt.md',
  },
  translate: {
    scan_per_second: 8,
    stable_wait_ms: 200,
    context_lines: 12,
    response_mime_type: 'application/json',
    temperature: 0.2,
    thinking_level: 'low',
    max_image_width: 1600,
  },
  display: {
    mode: 'replace',          // replace | band | panel
    min_font_px: 14,
    font_family: '',          // empty = pick by target language
    show_hud: true,
    peek_key: 'Alt',
  },
  hotkeys: { toggle: 'F8', retranslate: 'F9', show_log: 'F10', zones: 'Ctrl+F8' },
  profile: {
    identify_on_first_play: true,
    identify_after_text_lines: 3,
    use_web_search: true,
    update_on_new_speaker: true,
    update_every_lines: 60,
    update_min_interval_s: 300,
    transcript_lines_per_update: 80,
  },
};

const LANGUAGE_NAMES = {
  'auto': 'the game\'s language',
  'ja': 'Japanese', 'ko': 'Korean', 'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese',
  'en': 'English', 'ru': 'Russian', 'de': 'German', 'fr': 'French', 'es': 'Spanish', 'pt': 'Portuguese',
  'it': 'Italian', 'pl': 'Polish', 'uk': 'Ukrainian', 'vi': 'Vietnamese', 'th': 'Thai',
};
function languageName(code) { return LANGUAGE_NAMES[code] || code; }

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = (typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]))
      ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

const settingsPath = path.join(CONFIG_DIR, 'settings.json');
function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* defaults */ }
  return deepMerge(DEFAULTS, raw);
}
function saveSettings(next) {
  const merged = deepMerge(loadSettings(), next);
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

function loadPrompt(name, settings, vars = {}) {
  const file = path.join(CONFIG_DIR, settings.prompts[name]);
  let text = fs.readFileSync(file, 'utf8');
  const all = {
    source_language: languageName(settings.languages.source),
    target_language: languageName(settings.languages.target),
    ...vars,
  };
  return text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in all ? all[k] : m));
}

function keyInfo(settings) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, settings.key_file), 'utf8'));
    return { saved: true, hint: j.hint, saved_at: j.saved_at };
  } catch { return { saved: false }; }
}

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const script = path.join(CONFIG_DIR, 'gemini-key.ps1').replace(/'/g, "''");
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `. '${script}'; [Console]::Out.Write((Get-GeminiKey))`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  cachedKey = out.trim();
  if (cachedKey.length < 20) { cachedKey = null; throw new Error('The saved Gemini key could not be read.'); }
  return cachedKey;
}
function forgetKey() { cachedKey = null; }

function exeVersionInfo(exePath) {
  try {
    const p = exePath.replace(/'/g, "''");
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Item -LiteralPath '${p}').VersionInfo | Select-Object ProductName,CompanyName,FileDescription,ProductVersion | ConvertTo-Json -Compress`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return JSON.parse(out);
  } catch { return {}; }
}

module.exports = {
  ROOT, CONFIG_DIR, DATA_DIR, DEFAULTS, loadSettings, saveSettings, loadPrompt,
  keyInfo, getKey, forgetKey, exeVersionInfo, languageName, LANGUAGE_NAMES,
};
