// One local model server's live progress, in the page's own words.
//
// A local server is the only place that can say "8,192 of 108,553 tokens read":
// the engine's event stream starts a step, then goes quiet until the first token.
// The server's own /metrics knows the middle. This module asks it, normalises the
// answer to the small shape `web/waiting.js` consumes, and says nothing when the
// server has no such endpoint.
//
// It is deliberately local-only at the caller: `src/api.js` refuses a remote
// provider before this runs. The endpoint is a capability, not a contract — a
// server that does not answer gets `ok: false` and the page keeps its generic
// line.

const CACHE_MS = 700;
const cache = new Map();

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const rootOf = (baseURL) =>
  String(baseURL || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1$/i, '');

const pick = (obj, keys) => {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return 0;
};

/** The common shape the page reads. Never includes a key, a base URL or raw hardware. */
function normalise(body, at) {
  if (!body || typeof body !== 'object') return null;

  // A local wrapper may put the live request under `live`. A server that reports
  // its slots instead answers /slots with an array; `fromSlot` handles that.
  const live = body.live && typeof body.live === 'object' ? body.live : body;
  if (!live || typeof live !== 'object') return null;

  const state = String(live.state || live.phase || '').toLowerCase();
  const read = num(pick(live, ['prompt_read', 'prompt_n', 'promptRead', 'prompt_tokens_read']));
  // `prompt_tokens` is the total on the servers that report it beside
  // `prompt_read`; it is never used as the read counter.
  const total = num(pick(live, ['prompt_total', 'promptTotal', 'prompt_tokens_total', 'prompt_tokens']));
  const generated = num(pick(live, ['generated', 'n_decoded', 'output_tokens', 'tokens_generated']));
  const elapsed = num(pick(live, ['elapsed_s', 'elapsed', 'prompt_seconds', 'seconds']));
  const tokPerSec = num(pick(live, ['tok_s', 'tokens_per_second', 'tokPerSecond']));

  let phase = '';
  if (/load/.test(state)) phase = 'loading';
  else if (/queue|wait/.test(state)) phase = 'queued';
  else if (read > 0 && total > 0 && read < total) phase = 'prefill';
  else if (/prefill|prompt|read/.test(state) && total > 0) phase = 'prefill';
  else if (/generat|think|decode/.test(state) || generated > 0) phase = 'generating';
  else if (read > 0 && total > 0) phase = 'prefill';
  else phase = 'connected';

  return {
    ok: true,
    reachable: true,
    state: phase,
    read,
    total,
    generated,
    elapsed,
    tokPerSec,
    at,
  };
}

/** A `/slots` answer: the active slot is the one being processed. */
function fromSlot(body, at) {
  const slots = Array.isArray(body) ? body : Array.isArray(body?.slots) ? body.slots : null;
  if (!slots || !slots.length) return null;
  const slot = slots.find((s) => s && (s.is_processing || /process|generat/i.test(String(s.state || '')))) || slots[0];
  if (!slot || typeof slot !== 'object') return null;
  const read = num(pick(slot, ['prompt_n', 'prompt_read', 'promptRead']));
  const total = num(pick(slot, ['prompt_total', 'n_prompt_tokens', 'prompt_tokens']));
  const generated = num(pick(slot, ['n_decoded', 'generated']));
  const processing = Boolean(slot.is_processing) || /process|generat/i.test(String(slot.state || ''));
  return {
    ok: true,
    reachable: true,
    state: !processing ? 'connected' : read > 0 && total > 0 && read < total ? 'prefill' : 'generating',
    read,
    total,
    generated,
    elapsed: num(pick(slot, ['elapsed_s', 'elapsed'])),
    tokPerSec: num(pick(slot, ['tok_s', 'tokens_per_second'])),
    at,
  };
}

async function getJson(url, { apiKey = '', fetchImpl = fetch, timeoutMs = 700 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || 700));
  timer.unref?.();
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, json: false };
    }
    return { ok: true, body, status: res.status };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask a local provider for its live request.
 *
 * `ok: false` means "this server does not speak this dialect" — not that the turn
 * failed. The page then keeps the engine's own line.
 */
export async function fetchProviderLive(provider, { fetchImpl = fetch, timeoutMs = 700, now = Date.now() } = {}) {
  const root = rootOf(provider?.baseURL);
  if (!root || !/^https?:\/\//i.test(root)) {
    return { ok: false, reachable: false, reason: 'no local address', at: now };
  }
  const key = String(provider?.id || root);
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;

  const headers = { apiKey: String(provider?.apiKey || '').trim(), fetchImpl, timeoutMs };

  // The live shape first: it carries the read/total count while the prompt is
  // being processed. /slots is the llama.cpp-family fallback.
  const metrics = await getJson(`${root}/metrics`, headers);
  if (metrics.ok) {
    const live = normalise(metrics.body, now);
    if (live) {
      cache.set(key, { at: now, value: live });
      return live;
    }
  }

  const slots = await getJson(`${root}/slots`, headers);
  if (slots.ok) {
    const live = fromSlot(slots.body, now);
    if (live) {
      cache.set(key, { at: now, value: live });
      return live;
    }
    const connected = { ok: true, reachable: true, state: 'connected', read: 0, total: 0, generated: 0, elapsed: 0, tokPerSec: 0, at: now };
    cache.set(key, { at: now, value: connected });
    return connected;
  }

  const failed = { ok: false, reachable: false, reason: 'no live endpoint', at: now };
  cache.set(key, { at: now, value: failed });
  return failed;
}

/** Drop the short cache; used by tests and by a provider edit. */
export function clearProviderLiveCache() {
  cache.clear();
}
