// Which context window a model has — one answer, in one place.
//
// This was worked out in four places (the API, the runner, the boot measurement
// and the page) from four sources that could disagree, and five rounds of fixes
// never ended because each fix corrected one copy while another kept the old
// number. The symptom the operator kept reporting is the shape of that: a local
// model loaded at 128k, and the card saying 60k because the config still held the
// number measured the last time the model was loaded at 60k.
//
// So the rule lives here now, and every caller asks this module:
//
//   1. **measured** — a local runtime's loaded length, or the size of a prompt a
//      provider refused. A measurement beats every claim, in both directions.
//   2. **override** — the operator's `modelLimits` entry, boundary-tested by hand.
//   3. **provider entry** — what Settings holds for the model; a measurement
//      writes here so the engine and the next boot start from the same number.
//   4. **catalog** — the engine's own value, which is where this started.
//
// The cache is the second half of the fix. A number, once resolved, is remembered
// against the model ref, so the card cannot flip between sources while the model
// stays the same — and it is never silently replaced by a worse one. It changes
// when a measurement says so, when the operator edits the model, or when the
// model changes.
import { providerLoadedWindow, providerLoadedWindows, providerType } from './providers.js';

/**
 * Which number wins, given four claims about one model.
 *
 * `loaded` is the only measurement of what a server will actually take, so it
 * wins outright. `override` outranks a refusal on purpose: a refusal is one
 * provider's answer on one afternoon, and the override is a number the operator
 * made that provider serve at the boundary. A refused prompt only beats a catalog
 * claim larger than itself — it is an upper bound, not a window.
 */
export function resolveWindow({ override = 0, loaded = 0, refused = 0, catalog = 0 } = {}) {
  const n = (v) => Number(v) || 0;
  const o = n(override);
  const l = n(loaded);
  const r = n(refused);
  const c = n(catalog);
  if (l) return l;
  if (o) return o;
  if (r && (!c || r < c)) return r;
  return c;
}

/** `provider/model` in, its two halves out. A ref without a slash is all model. */
export function splitRef(ref) {
  const text = String(ref || '');
  const at = text.indexOf('/');
  if (at < 0) return { providerId: '', modelId: text };
  return { providerId: text.slice(0, at), modelId: text.slice(at + 1) };
}

/** The provider row a ref names, when this config holds one. */
export function providerOf(config, ref) {
  const { providerId, modelId } = splitRef(ref);
  const provider = (config?.engine?.opencode?.providers || []).find((p) => p.id === providerId) || null;
  return { provider, modelId };
}

/**
 * What the config says, and whether the operator set it.
 *
 * `modelLimits` may be keyed either way — the engine's config takes the bare model
 * id while a ref is `provider/model` — and both spellings are honoured here, once,
 * for every caller.
 */
export function declaredWindow(config, ref) {
  const { provider, modelId } = providerOf(config, ref);
  const limits = config?.modelLimits || {};
  const override = limits[String(ref || '')] || limits[modelId] || {};
  const model = (provider?.models || []).find((m) => m.id === modelId);
  return {
    override: Number(override.context) || 0,
    output: Number(override.output) || Number(model?.output) || 0,
    context: Number(model?.context) || 0,
  };
}

/** What the engine's catalog says, which is what it was told when it started. */
export function catalogWindow(cache, ref) {
  let record = null;
  try {
    record = cache?.get ? cache.get(ref) : null;
  } catch {
    // A cache that cannot answer is not a window; the config still decides.
    record = null;
  }
  return {
    context: Number(record?.context) || 0,
    output: Number(record?.output) || 0,
    refusedAt: Number(record?.refusedAt) || 0,
  };
}

// ── the memory ──────────────────────────────────────────────────
// One resolved number per model ref. Not persisted: the config entry carries it
// across restarts, and boot measures the local runtimes again before the engine
// is handed its config.
const measured = new Map(); // ref -> { context, output, source, at }

/** The number remembered for a ref, or null. */
export function remembered(ref) {
  return measured.get(String(ref || '')) || null;
}

/** Remember a number for a ref. A zero is not an answer and is not stored. */
export function remember(ref, { context, output = 0, source = 'loaded' } = {}) {
  const n = Number(context) || 0;
  if (!ref || !n) return null;
  const record = { context: n, output: Number(output) || 0, source, at: Date.now() };
  measured.set(String(ref), record);
  return record;
}

/** Forget one model — the operator edited it, or it left the catalog. */
export function forget(ref) {
  measured.delete(String(ref || ''));
}

/** Forget everything. Tests only. */
export function clearMemory() {
  measured.clear();
}

/**
 * The number to draw on the card and budget with. Synchronous, because both the
 * stream and a poll ask for it, and neither can wait on a server.
 */
export function knownWindow(config, ref, { cache } = {}) {
  if (!ref) return { context: 0, output: 0, source: 'none' };
  const declared = declaredWindow(config, ref);
  const catalog = catalogWindow(cache, ref);
  const memory = remembered(ref);
  const context = resolveWindow({
    override: declared.override,
    loaded: memory?.context || 0,
    refused: catalog.refusedAt,
    catalog: declared.context || catalog.context,
  });
  const output = Number(declared.output) || Number(catalog.output) || 0;
  const source = memory?.context
    ? memory.source || 'loaded'
    : declared.override
      ? 'override'
      : declared.context
        ? 'provider'
        : catalog.context
          ? 'catalog'
          : 'none';
  return { context, output, source };
}

/**
 * Ask a local server what window it has loaded for this model, and remember it.
 *
 * The only honest source for a local model: LM Studio (or whatever serves it)
 * loads a model at whatever context the operator picked there, and that number
 * changes when the model is reloaded — which is the case five fixes kept missing.
 * A server that is not answering, or has a different model loaded, changes
 * nothing: the last known number stands.
 */
export async function refreshWindow(config, ref, { cache, fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const before = knownWindow(config, ref, { cache });
  const { provider, modelId } = providerOf(config, ref);
  if (!provider || providerType(provider) !== 'local') {
    return { ...before, previous: before.context, changed: false };
  }
  const loaded = await providerLoadedWindow(
    { baseURL: provider.baseURL, model: modelId, models: (provider.models || []).length },
    { fetchImpl, timeoutMs },
  ).catch(() => 0);
  if (!loaded) return { ...before, previous: before.context, changed: false };
  remember(ref, { context: loaded, output: before.output, source: 'loaded' });
  const after = knownWindow(config, ref, { cache });
  return { ...after, previous: before.context, changed: before.context !== after.context };
}

/**
 * The same question for every local provider at once, at boot.
 *
 * One request per server, and only models it reports as *loaded*: what it says it
 * could load is a capability, not the window it will serve. Returns the changes so
 * the boot line can say what it learned.
 */
export async function refreshLocalProviders(config, { fetchImpl = fetch, timeoutMs = 1500 } = {}) {
  const changes = [];
  for (const provider of config?.engine?.opencode?.providers || []) {
    if (providerType(provider) !== 'local') continue;
    const windows = await providerLoadedWindows(provider, { fetchImpl, timeoutMs }).catch(() => null);
    if (!windows || !windows.size) continue;
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      const modelId = String(model.id || '').trim();
      if (!modelId) continue;
      // `*` is the one the server named; a specific id is that model's window.
      const loaded = Number(windows.get(modelId)) || (windows.size === 1 ? Number(windows.get('*')) : 0) || 0;
      if (!loaded) continue;
      const ref = `${provider.id}/${modelId}`;
      const before = knownWindow(config, ref).context;
      remember(ref, { context: loaded, output: Number(model.output) || 0, source: 'loaded' });
      if (before !== loaded) changes.push({ ref, from: before, to: loaded });
    }
  }
  return changes;
}

/**
 * Write a resolved number into the config's provider entry.
 *
 * This is what keeps the engine's own compaction point and the card on the same
 * number after a restart: the engine is handed `limit.context` from this entry.
 * Returns whether anything changed, so the caller saves and broadcasts once.
 */
export function writeIntoConfig(config, ref, { context, output } = {}) {
  const { modelId } = splitRef(ref);
  const { provider } = providerOf(config, ref);
  const model = (provider?.models || []).find((m) => m.id === modelId);
  if (!model) return false;
  let changed = false;
  const n = Number(context) || 0;
  const o = Number(output) || 0;
  if (n && Number(model.context) !== n) {
    model.context = n;
    changed = true;
  }
  if (o && Number(model.output) !== o) {
    model.output = o;
    changed = true;
  }
  return changed;
}
