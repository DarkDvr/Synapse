// Provider definitions: a type the Settings screen can offer, an id derived from
// the operator's own name, and one honest network call.
//
// Everything here is about *describing* a provider. Registration still happens in
// src/engines/opencode.js (one engine's business), and the key rule in
// src/config.js (one config's business) — this file is the part both the API and
// the tests can share without dragging an engine along.

/** The types the Settings screen offers. `opencode` is not one of them: the
 *  engine's own catalog is already registered and always will be, so a second
 *  copy would be the same models twice under a different name.
 *
 *  `llamacpp` is a *local* server too — it is the same kind of thing as `local`,
 *  reached over the same OpenAI chat API, and it differs only in how it answers
 *  questions about itself (`/props` instead of LM Studio's `/api/v0/models`). It is
 *  named for the dialect rather than for one product, because any wrapper around
 *  llama.cpp speaks it: llama-server, KoboldCpp, and the game-PC MoE engines. */
export const ADDABLE_PROVIDER_TYPES = ['local', 'llamacpp', 'openai'];

/** Is this provider a server on this machine? `llamacpp` is one, and so is any
 *  address that points at localhost whatever it calls itself. */
export function isLocalProvider(provider) {
  return providerType(provider) === 'local';
}

/** What a provider *is*, from what it points at. A config written before types
 *  existed answers the same way the screen would, so nothing is lost by not
 *  having stored it. `llamacpp` is folded into `local`: every check downstream is
 *  about "a server on this machine", not about which dialect it speaks. */
export function providerType(provider) {
  const declared = String(provider?.type || '').trim().toLowerCase();
  if (declared === 'llamacpp') return 'local';
  if (ADDABLE_PROVIDER_TYPES.includes(declared)) return declared;
  const url = String(provider?.baseURL || '');
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url) ? 'local' : 'openai';
}

/** The declared type, kept for the screen. A stored `llamacpp` stays `llamacpp`;
 *  anything unrecognised becomes the kind it behaves as. */
export function declaredProviderType(provider) {
  const declared = String(provider?.type || '').trim().toLowerCase();
  if (ADDABLE_PROVIDER_TYPES.includes(declared)) return declared;
  return providerType(provider);
}

/** A stable id from a display name: `DeepSeek (official)` -> `deepseek-official`.
 *  It is what a model ref is built from (`deepseek/deepseek-flash`), so it is
 *  chosen once, when the provider is created, and never derived again. */
export function providerId(name, taken = []) {
  const base =
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'provider';
  const used = new Set((taken || []).map((t) => String(t).toLowerCase()));
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

const CONTEXT_KEYS = ['context_length', 'max_context_length', 'loaded_context_length', 'max_model_len', 'context_window'];

// Which of those describe what the server will *serve*, and which only describe the// model's ceiling. The difference matters: LM Studio's `max_context_length` is what
// the model could take, not what it was loaded at, and reporting it as a window is
// how a 42k model gets treated as a 262k one.
const LOADED_KEYS = ['loaded_context_length', 'n_ctx', 'context_length', 'max_model_len'];
const MAX_ONLY_KEYS = ['max_context_length', 'context_window'];

/**
 * The window a list entry reports, wherever that server chose to put it.
 *
 * Three shapes are in the wild and each nests it differently: LM Studio puts
 * `loaded_context_length` at the top of each entry, vLLM puts `max_model_len`
 * there, and a llama.cpp-family server answers `/v1/models` with
 * `meta: { n_ctx }`. Reading only the top level meant a server that was saying
 * its window plainly was reported as having none — and for a local provider that
 * is a model with no window at all: no watchdog, and no limit handed to the
 * engine, which then budgets from a catalog that has never heard of it.
 *
 * `loadedOnly` is for the probe that decides what a run budgets from: there a
 * maximum is not an answer, so the keys that only describe the ceiling are skipped.
 */
function contextFrom(m, { loadedOnly = false } = {}) {
  if (!m || typeof m !== 'object') return 0;
  const keys = loadedOnly ? LOADED_KEYS : [...LOADED_KEYS, ...MAX_ONLY_KEYS];
  const pick = (holder) => {
    for (const key of keys) {
      const n = Number.parseInt(holder[key], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };
  const top = pick(m);
  if (top) return top;
  for (const nested of [m.meta, m.status, m.default_generation_settings]) {
    if (!nested || typeof nested !== 'object') continue;
    const n = pick(nested);
    if (n) return n;
  }
  return 0;
}

/** Ollama's native list is at `/api/tags`, and its base URL is usually given with
 *  the OpenAI `/v1` on the end. Both spellings land on the same place here. */
function ollamaTagsUrl(root) {
  return `${root.replace(/\/v1$/i, '')}/api/tags`;
}

/**
 * Ask a server what it serves. `POST /api/providers/models` in the Settings
 * screen is this function, and it is the only place Synapse contacts a provider
 * outside a turn — because the operator pressed a button, exactly like the
 * engine update check. Nothing here is periodic and nothing runs at boot.
 *
 * Two list formats exist in the wild and both are worth trying: the OpenAI
 * `/models` (LM Studio, vLLM, most of the paid vendors) and Ollama's `/api/tags`.
 * `format` only chooses which is tried first — a server that answers the other
 * one is still understood, so the operator does not have to know which it is.
 *
 * The answer is normalised to what the models editor needs (an id, a readable
 * name, a window when the server offers one) and an error is returned as a
 * sentence, never as a stack trace. The API key is never echoed back.
 */
export async function fetchProviderModels({ baseURL, apiKey, format, type } = {}, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const root = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(root)) return { ok: false, models: [], error: 'The server URL must start with http:// or https://.' };
  const key = String(apiKey || '').trim();
  const openAiUrl = `${root}/models`;
  const tagsUrl = ollamaTagsUrl(root);
  const order = format === 'ollama' ? [tagsUrl, openAiUrl] : [openAiUrl, tagsUrl];
  const notes = [];

  for (const url of order) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const detail = firstLine(text);
        notes.push(`answered ${res.status} at ${label(url)}${detail ? ` ("${detail}")` : ''}`);
        continue;
      }
      let body;
      try { body = JSON.parse(text); } catch {
        notes.push(`answered something that is not JSON at ${label(url)}`);
        continue;
      }
      const models = normaliseList(body);
      if (!models.length) {
        notes.push(`listed no models at ${label(url)}`);
        continue;
      }
      // A local runtime knows the window of the model it has *loaded* — LM
      // Studio answers /api/v0/models with loaded_context_length. An unloaded
      // model reports none, and guessing its maximum would be a bigger lie than
      // saying nothing: the watchdog would never compact and the server would
      // truncate. So only the loaded length is taken — and it wins over any
      // maximum the list itself offered, because a maximum is not a window.
      if (type === 'local') {
        const windows = await probeLoadedWindows(root, fetchImpl, timeoutMs);
        if (windows.size) {
          for (const m of models) {
            // `*` is the single loaded model a /props server reports; it applies to
            // any id, because that server can only have the one loaded.
            const known = windows.get(m.id) || windows.get('*') || 0;
            if (known) m.context = known;
            else delete m.context;
          }
        }
      }
      return { ok: true, models, error: '' };
    } catch (err) {
      notes.push(
        err?.name === 'AbortError'
          ? `did not answer within ${Math.round(timeoutMs / 1000)} seconds`
          : err?.cause?.code === 'ECONNREFUSED'
            ? 'refused the connection (nothing is listening there)'
            : `failed with ${firstLine(err?.message || String(err))}`,
      );
      // A refused connection will be refused at the other endpoint too.
      if (err?.cause?.code === 'ECONNREFUSED') break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, models: [], error: sentence(notes) };
}

/**
 * Every window a local runtime reports as *loaded*, by model id.
 *
 * Several answers exist and a server has whichever it has, so all of them are
 * tried against one shared deadline — this runs at boot, and a provider that
 * cannot be reached must cost the start-up a second at most, not three:
 *
 *   /api/v0/models   LM Studio   — `loaded_context_length` per model
 *   /props           llama.cpp   — `default_generation_settings.n_ctx` for the one
 *                                  model it has loaded, named by `model_alias`
 *   /v1/models       a wrapper   — `meta.n_ctx`, via contextFrom
 *
 * Only what the server has *reserved* is taken. `max_context_length` is what the
 * model could take; a model nobody loaded has been given no window at all, and
 * guessing one would have the watchdog wait for a limit the server never had.
 */
async function probeLoadedWindows(root, fetchImpl, timeoutMs) {
  const windows = new Map();
  const base = root.replace(/\/v1$/i, '');
  const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 1500);

  const get = async (path) => {
    const left = deadline - Date.now();
    if (left < 150) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), left);
    timer.unref?.();
    try {
      const res = await fetchImpl(`${base}${path}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      return JSON.parse(await res.text());
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // LM Studio first: it reports a window for every loaded model at once, and its
  // answer is the most precise of the three.
  const lm = await get('/api/v0/models');
  const lmList = Array.isArray(lm?.data) ? lm.data : Array.isArray(lm?.models) ? lm.models : [];
  for (const m of lmList) {
    const id = String(m?.id || m?.model_key || '').trim();
    const n = Number.parseInt(m?.loaded_context_length, 10);
    if (id && Number.isFinite(n) && n > 0) windows.set(id, n);
  }
  if (windows.size) return windows;

  // Then llama.cpp's own endpoint: one loaded model, named by its alias.
  const props = await get('/props');
  const alias = String(props?.model_alias || '').trim();
  const ctx = Number.parseInt(props?.default_generation_settings?.n_ctx, 10);
  if (Number.isFinite(ctx) && ctx > 0) {
    if (alias) windows.set(alias, ctx);
    // A /props server has loaded exactly one model and has told us its window.
    // Recorded under `*` as well, so a model whose id differs from the alias still
    // gets the right number rather than none.
    windows.set('*', ctx);
  }
  if (windows.size) return windows;

  // Last, a wrapper's own list: meta.n_ctx and friends, read by contextFrom.
  const list = await get('/v1/models');
  const entries = Array.isArray(list?.data) ? list.data : Array.isArray(list?.models) ? list.models : [];
  for (const m of entries) {
    const id = String(m?.id || m?.model || m?.name || '').trim();
    const n = contextFrom(m, { loadedOnly: true });
    if (id && n > 0) windows.set(id, n);
  }
  return windows;
}

/**
 * Every window a local runtime reports as *loaded*, by model id. One request.
 *
 * This is the number that matters, and it is the runtime's, not this app's: LM
 * Studio loads a model at whatever context the operator picked over there, and
 * the engine's own compaction rule is a function of the number the engine was
 * told. Empty when the server is not LM Studio or is not answering.
 */
export async function providerLoadedWindows({ baseURL } = {}, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const root = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(root)) return new Map();
  return probeLoadedWindows(root, fetchImpl, timeoutMs);
}

/**
 * The window a local server has *actually loaded* for one model, or 0 when it
 * cannot say. Asked at run start, per model, so it must be one cheap request.
 *
 * This is the check that would have saved Shift Test 2: the operator changed the
 * context in LM Studio to 16k while Synapse still believed the 39k in its config,
 * and a 17.7k request was refused by the server mid-task.
 */
export async function providerLoadedWindow({ baseURL, model }, opts = {}) {
  const windows = await providerLoadedWindows({ baseURL }, opts);
  const wanted = String(model || '').trim();
  // `*` is the one model a /props server has loaded, whichever name it gives it.
  return windows.get(wanted) || windows.get('*') || 0;
}

/**
 * Is this local server answering right now?
 *
 * One GET to the models endpoint, which every OpenAI-compatible server has, and
 * a timeout short enough that a dead port cannot hold the sidebar. It is a
 * question about *now*, not about configuration: a server can be registered and
 * off, which is the case the operator keeps hitting - they turn one on and want
 * to know whether Synapse can see it.
 */
export async function providerUp(provider, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const root = String(provider?.baseURL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(root)) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${root}/models`, { signal: ctrl.signal });
    return Boolean(res?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Put what the local runtimes have loaded into the config, and say what changed.
 *
 * Called once at boot, before the engine is handed its config: a window typed
 * into a form is a claim, and this is the measurement that outranks it. Two
 * things follow from doing it here rather than in the UI — nobody has to retype
 * a number when they reload a model, and the engine is *told* the same window the
 * watchdog uses, so its own compaction point is not 18k below ours.
 *
 * A server that is not answering changes nothing: the last known window stands.
 */
export async function measureLocalWindows(config, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const providers = config?.engine?.opencode?.providers;
  if (!Array.isArray(providers)) return [];
  const changes = [];
  for (const p of providers) {
    if (providerType(p) !== 'local') continue;
    const windows = await providerLoadedWindows(p, { fetchImpl, timeoutMs });
    if (!windows.size) continue;
    for (const m of Array.isArray(p.models) ? p.models : []) {
      const loaded = windows.get(String(m.id || '').trim()) || windows.get('*') || 0;
      if (!loaded) continue;
      const from = Number(m.context) || 0;
      if (from === loaded) continue;
      m.context = loaded;
      changes.push({ ref: `${p.id || 'local'}/${m.id}`, from, to: loaded });
    }
  }
  return changes;
}

/** The endpoint as the operator sees it: /models or /api/tags. */
function label(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

function normaliseList(body) {
  const list = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : Array.isArray(body)
        ? body
        : [];
  return list
    .map((m) => {
      // Ollama tags carry `name` and `model`; OpenAI carries `id`.
      const id = String(typeof m === 'string' ? '' : m?.id || m?.name || m?.model || '').trim();
      if (!id) return null;
      // A bare string entry names a model and nothing else.
      const name = String(typeof m === 'string' ? '' : m?.name || m?.display_name || '').trim();
      const context = typeof m === 'string' ? 0 : contextFrom(m);
      return { id, name: name || id, context };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** One line, in the operator's language: what was tried and what came back. */
function sentence(notes) {
  const unique = [...new Set(notes)];
  if (!unique.length) return 'The server did not answer.';
  const said = unique.length === 1 ? unique[0] : `${unique.slice(0, -1).join('; ')}; and ${unique[unique.length - 1]}`;
  return `The server ${said}.`.replace(/^The server ([a-z])/, (_, c) => `The server ${c}`);
}

function firstLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}
