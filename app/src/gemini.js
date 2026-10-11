'use strict';
// Minimal Gemini REST client: streaming and one-shot generateContent.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

class GeminiError extends Error {
  constructor(message, status, retryable) { super(message); this.status = status; this.retryable = retryable; }
}

function describeError(status, bodyText) {
  let msg = bodyText;
  try { msg = JSON.parse(bodyText).error.message || bodyText; } catch { /* keep text */ }
  msg = String(msg).slice(0, 300);
  if (status === 429) return new GeminiError(`Rate limited by Gemini: ${msg}`, status, true);
  if (status >= 500) return new GeminiError(`Gemini server error ${status}: ${msg}`, status, true);
  if (status === 400 || status === 401 || status === 403) return new GeminiError(`Gemini refused the request (${status}): ${msg}`, status, false);
  return new GeminiError(`Gemini error ${status}: ${msg}`, status, false);
}

function textOf(chunk) {
  const parts = chunk?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
}

// Streams a reply. onText(delta) is called for every piece of answer text.
async function stream({ key, model, body, onText, signal, timeoutMs = 30000 }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  const t0 = Date.now();
  let firstAt = null, usage = null, full = '', finish = null, grounding = null;
  try {
    const res = await fetch(`${BASE}${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw describeError(res.status, await res.text());
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let pending = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += dec.decode(value, { stream: true });
      let idx;
      while ((idx = pending.search(/\r?\n\r?\n/)) >= 0) {
        const event = pending.slice(0, idx);
        pending = pending.slice(idx).replace(/^\r?\n\r?\n/, '');
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          let chunk;
          try { chunk = JSON.parse(data); } catch { continue; }
          if (chunk.error) throw describeError(chunk.error.code || 500, JSON.stringify(chunk));
          const t = textOf(chunk);
          if (t) {
            if (firstAt === null) firstAt = Date.now() - t0;
            full += t;
            onText && onText(t);
          }
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          const cand = chunk.candidates?.[0];
          if (cand?.finishReason) finish = cand.finishReason;
          if (cand?.groundingMetadata) grounding = cand.groundingMetadata;
        }
      }
    }
  } catch (e) {
    if (e instanceof GeminiError) throw e;
    if (ctrl.signal.aborted && signal?.aborted) throw new GeminiError('Cancelled', 0, false);
    if (ctrl.signal.aborted) throw new GeminiError(`Gemini did not answer within ${Math.round(timeoutMs / 1000)} s`, 0, true);
    throw new GeminiError(`Could not reach Gemini: ${e.message}`, 0, true);
  } finally {
    clearTimeout(timer);
  }
  return { text: full, usage, finish, grounding, ms: Date.now() - t0, firstMs: firstAt };
}

async function generate({ key, model, body, timeoutMs = 120000 }) {
  return stream({ key, model, body, timeoutMs });
}

module.exports = { stream, generate, GeminiError };
