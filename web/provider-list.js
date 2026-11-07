// Which providers exist, what they are called, in what order the operator put them,
// and which of the engine's own they have removed from the list.
//
// Three parts of the page ask the same question — the Providers pane, the model
// picker and the role cards — and they must never disagree about a name or an order:
// the model menu sorting by label instead of the operator's order was a real bug
// (4 Nov). So the answer lives in one module.
import { state } from './state.js';
import { api } from './api.js';
import { slugify, providerBadge } from './settings-data.js';

/**
 * The rows the engine serves itself, and what it calls them.
 *
 * This used to be a literal in this file — two OpenCode ids, two labels and two
 * sentences — which is engine knowledge inside a module that has to work with any
 * engine. The adapter declares them now (`engineProviders()` in
 * `src/engines/opencode.js`), the server hands them over once at boot, and the page
 * only draws them. An engine that declares nothing gets an empty list, and the
 * operator's own providers are all that is shown.
 */
export let ENGINE_PROVIDERS = [];

/** Ask the server which providers its engine serves. Called once, from boot. */
export async function loadEngineProviders() {
  try {
    const r = await api('GET', '/api/providers');
    ENGINE_PROVIDERS = Array.isArray(r?.providers) ? r.providers : [];
  } catch {
    // The engine could not say: the config's own providers still list, and an id
    // falls back to its own words rather than to a name this file invented.
    ENGINE_PROVIDERS = [];
  }
  return ENGINE_PROVIDERS;
}

export const providerLabel = (p) => {
  const id = String(p || 'unknown');
  const configured = (state.config?.engine?.opencode?.providers || []).find((x) => x.id === id);
  // A local server is labelled by what it *is*, not by the app that happens to
  // be running it: the next machine's may be Ollama or vLLM, and a badge naming
  // one of them would be wrong everywhere else.
  if (configured) return providerBadge(configured) || id;
  const engine = ENGINE_PROVIDERS.find((x) => x.id === id);
  if (engine) return engine.label;
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
};

// ── the provider order ──────────────────────────────────────────
// Settings lists providers in one order the operator arranges (`providerOrder`
// in the config, an array of ids), and the model menu follows it. Two lists that
// disagreed were the complaint: the operator moved a provider up and the picker
// still grouped by label (4 Nov). Built-in catalog rows are in the same order:
// "OpenCode Zen at the bottom" means the engine's own row can be moved too.
export function knownProviderIds(c) {
  // An engine provider the operator removed in Settings is gone from this list, so
  // its row goes and its models leave the menu (the server filters them). The
  // engine still serves them, and Add Provider puts the row back.
  const hidden = hiddenProviderIds(c);
  const custom = (c?.engine?.opencode?.providers || []).map((p) => String(p.id || slugify(p.name)));
  const engine = ENGINE_PROVIDERS.map((p) => p.id).filter((id) => !hidden.has(id));
  return [...new Set([...engine, ...custom])];
}

/** The engine providers this config has removed from the list, as a Set of ids. */
export function hiddenProviderIds(c = state.config) {
  return new Set((c?.engine?.opencode?.hiddenProviders || []).map(String));
}

export function providerOrderOf(c) {
  const all = knownProviderIds(c);
  const saved = Array.isArray(c?.engine?.opencode?.providerOrder) ? c.engine.opencode.providerOrder : [];
  const out = [];
  for (const id of saved) if (all.includes(String(id)) && !out.includes(String(id))) out.push(String(id));
  // Anything the saved order does not mention keeps its default place at the
  // end, so a provider added tomorrow appears without being placed by hand.
  for (const id of all) if (!out.includes(id)) out.push(id);
  return out;
}
