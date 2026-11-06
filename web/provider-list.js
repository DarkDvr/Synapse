// Which providers exist, what they are called, in what order the operator put them,
// and which of the engine's own they have removed from the list.
//
// Three parts of the page ask the same question — the Providers pane, the model
// picker and the role cards — and they must never disagree about a name or an order:
// the model menu sorting by label instead of the operator's order was a real bug
// (4 Nov). So the answer lives in one module.
import { state } from './state.js';
import { slugify, providerBadge } from './settings-data.js';

export const ENGINE_PROVIDERS = [
  { id: 'opencode', label: 'OC Zen', note: 'Free models need no key; a Zen key unlocks the paid ones.' },
  { id: 'opencode-go', label: 'OC Go', note: 'Paid plan — its key lives in the engine.' },
];
const ENGINE_BADGES = Object.fromEntries(ENGINE_PROVIDERS.map((p) => [p.id, p.label]));
export const providerLabel = (p) => {
  const id = String(p || 'unknown');
  const configured = (state.config?.engine?.opencode?.providers || []).find((x) => x.id === id);
  // A local server is labelled by what it *is*, not by the app that happens to
  // be running it: the next machine's may be Ollama or vLLM, and a badge naming
  // one of them would be wrong everywhere else.
  if (configured) return providerBadge(configured) || id;
  if (ENGINE_BADGES[id]) return ENGINE_BADGES[id];
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
