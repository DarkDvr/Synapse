// Which providers exist, what they are called, and in what order the operator put
// them.
//
// Every provider is the operator's: OC Zen and OC Go are ordinary OpenAI-compatible
// rows now, added with Add Provider, moved and removed like any other. The engine
// registers models under provider ids, and a provider the config does not hold is not
// offered — so this list is the config's list, and nothing else.
//
// Three parts of the page ask the same question — the Providers pane, the model
// picker and the role cards — and they must never disagree about a name or an order:
// the model menu sorting by label instead of the operator's order was a real bug
// (4 Nov). So the answer lives in one module.
import { state } from './state.js';
import { slugify, providerBadge } from './settings-data.js';

/** A provider id said as a name, for one the config does not describe yet. */
const prettify = (id) =>
  String(id || 'unknown')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ') || 'unknown';

export const providerLabel = (p) => {
  const id = String(p || 'unknown');
  const configured = (state.config?.engine?.opencode?.providers || []).find((x) => x.id === id);
  // A local server is labelled by what it *is*, not by the app that happens to
  // be running it: the next machine's may be Ollama or vLLM, and a badge naming
  // one of them would be wrong everywhere else.
  if (configured) return providerBadge(configured) || id;
  return prettify(id);
};

// ── the provider order ──────────────────────────────────────────
// Settings lists providers in one order the operator arranges (`providerOrder`
// in the config, an array of ids), and the model menu follows it. Two lists that
// disagreed were the complaint: the operator moved a provider up and the picker
// still grouped by label (4 Nov).
export function knownProviderIds(c) {
  return [...new Set((c?.engine?.opencode?.providers || []).map((p) => String(p.id || slugify(p.name))))].filter(Boolean);
}

/** The providers this config has hidden, as a Set of ids. Kept for a config that
 *  still carries `hiddenProviders` from when the engine's rows could be hidden; the
 *  picker and the role cards use it for their "hidden in Settings" note. */
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
