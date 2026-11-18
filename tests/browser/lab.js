// The chat lab, in a real browser: play a scenario through the new renderer and measure it.
//
// It exists because two of the promises the rebuild has to keep cannot be seen without a
// browser: the reader's line does not move when the conversation updates, and the pane
// grows without moving anything outside it. The scenarios that need that (a burst, a tall
// form, a resize, the anchor under load) run here; the structural ones run in Node.
//
// Served by scripts/chat-lab.mjs, which stages `web/`, `tests/scenario-steps.mjs` and
// `tests/scenarios/` beside this file — the page imports exactly what the app ships.
import { state } from './web/state.js';
import { buildChat } from './web/chat-model.js';
import { createChatView } from './web/chat-view.js';
import { resetState, applyStep } from './tests/scenario-steps.mjs';

const host = document.getElementById('transcript');
const view = createChatView(host);
// Identity, for the check that the same key keeps the same element across updates.
const ids = new WeakMap();
let nextId = 0;
const idOf = (node) => {
  if (!ids.has(node)) ids.set(node, nextId += 1);
  return ids.get(node);
};

/** What a frame looked like: the list, the nodes, and where the viewport is. */
function measure(step, model) {
  const nodes = [...view.nodes.entries()].map(([key, held]) => `${key}#${held.node.childNodes.length}`);
  return {
    step,
    items: model.items.length,
    keys: (model.items || []).map((i) => i.key),
    nodes,
    text: host.textContent.length,
    scroll: { top: Math.round(host.scrollTop), height: host.scrollHeight, client: host.clientHeight },
  };
}

/**
 * Play a scenario file by name and answer every frame it drew.
 * `steps` may narrow it: `__labRun('S1-folds', 3)` stops after the third render.
 */
window.__labRun = async (name, only) => {
  const res = await fetch(`/tests/scenarios/${name}.json`);
  if (!res.ok) throw new Error(`no scenario "${name}" (${res.status})`);
  const scenario = await res.json();
  resetState(state);
  view.update(buildChat(state));
  const frames = [];
  for (const [i, step] of scenario.steps.entries()) {
    applyStep(state, step);
    if (step.do === 'open' || step.do === 'close') continue;
    const model = buildChat(state);
    view.update(model);
    frames.push(measure(i, model));
    if (Number(only) && frames.length >= Number(only)) break;
  }
  return frames;
};

/** The markup, for a check that needs to read rather than measure. */
window.__labHTML = () => host.innerHTML;

/** Scroll the transcript to a fraction of its height, then answer where it is. */
window.__labScrollTo = (fraction = 0.5) => {
  const max = Math.max(0, host.scrollHeight - host.clientHeight);
  host.scrollTop = Math.round(max * Math.max(0, Math.min(1, Number(fraction))));
  return { top: host.scrollTop, max };
};

/** Measure one element by its key, for a geometry check. */
window.__labBox = (key) => {
  const node = document.querySelector(`[data-key="${key}"]`) || host.querySelector(`[data-k="${key}"]`);
  if (!node) return null;
  const r = node.getBoundingClientRect();
  const box = host.getBoundingClientRect();
  return { top: Math.round(r.top - box.top), height: Math.round(r.height), open: 'open' in node ? node.open : null };
};
