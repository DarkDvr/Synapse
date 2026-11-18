// The chat lab, in a real browser: play a scenario through both renderers and compare.
//
// It exists because two of the promises the rebuild has to keep cannot be seen without a
// browser: the reader's line does not move when the conversation updates, and the pane
// grows without moving anything outside it. The scenarios that need that (a burst, a tall
// form, a resize, the anchor under load) run here; the structural ones run in Node.
//
// Two panels, one state: the old renderer draws into #transcript (its own id), the new one
// into #transcript-v2. Same stylesheet, same conversation, so a difference is a fact rather
// than an opinion. scripts/chat-lab.mjs stages and runs it.
import { state } from './web/state.js';
import { buildChat } from './web/chat-model.js';
import { createChatView } from './web/chat-view.js';
import { resetState, applyStep } from './tests/scenario-steps.mjs';
import { renderTranscript, transcriptWiring } from './web/transcript.js';
import { chatScrollWiring } from './web/chat-scroll.js';
import { tracesWiring } from './web/traces.js';

const oldHost = document.getElementById('transcript');
const newHost = document.getElementById('transcript-v2');
const view = createChatView(newHost);

// The wiring the old renderer needs to draw a transcript on its own.
transcriptWiring({
  renderRoleActivity() {},
  mountAskPost() {},
  renderPermissions: () => '',
  compactPostOf: () => null,
});
chatScrollWiring({ renderTranscript, traceOf: () => null, currentRun: () => null, askHost: () => null });
tracesWiring({ renderTranscript });

// Identity, for the check that the same key keeps the same element across updates.
const ids = new WeakMap();
let nextId = 0;
const idOf = (node) => {
  if (!ids.has(node)) ids.set(node, (nextId += 1));
  return ids.get(node);
};

const shape = (host) => ({
  text: host.textContent.replace(/\s+/g, ' ').trim(),
  posts: host.querySelectorAll('.msg').length,
  cards: host.querySelectorAll('.tool-card').length,
  folds: host.querySelectorAll('details').length,
  // Heights are the whole point of the pane check: a fixed window keeps them still.
  postHeights: [...host.querySelectorAll('.msg')].map((n) => Math.round(n.getBoundingClientRect().height)),
  paneHeights: [...host.querySelectorAll('.trace-flow-view')].map((n) => Math.round(n.getBoundingClientRect().height)),
  scroll: { top: Math.round(host.scrollTop), height: host.scrollHeight, client: host.clientHeight },
});

/** Draw both, and answer how they differ this frame. */
function frame(step, model) {
  state.renderSig = '';
  renderTranscript();
  view.update(model);
  const a = shape(oldHost);
  const b = shape(newHost);
  return {
    step,
    items: model.items.length,
    keys: (model.items || []).map((i) => i.key),
    nodes: [...view.nodes.entries()].map(([key, held]) => `${key}#${idOf(held.node)}`),
    old: { text: a.text.length, posts: a.posts, cards: a.cards, folds: a.folds, scroll: a.scroll, postHeights: a.postHeights, paneHeights: a.paneHeights },
    new: { text: b.text.length, posts: b.posts, cards: b.cards, folds: b.folds, scroll: b.scroll, postHeights: b.postHeights, paneHeights: b.paneHeights },
    // The same characters: a block join is a space in one renderer and a newline in the
    // other, which reads the same and is not a difference worth chasing.
    sameText: a.text.replace(/\s+/g, '') === b.text.replace(/\s+/g, ''),
  };
}

/**
 * Play a scenario file by name and answer every frame it drew.
 * `only` narrows it to the first N renders, for a shorter run.
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
    frames.push(frame(i, buildChat(state)));
    if (Number(only) && frames.length >= Number(only)) break;
  }
  return frames;
};

/** The full text of both panels, for a diff when they disagree. */
window.__labTexts = () => ({
  old: oldHost.textContent.replace(/\s+/g, ' ').trim(),
  new: newHost.textContent.replace(/\s+/g, ' ').trim(),
});

/** The markup of the new panel, for a check that needs to read rather than measure. */
window.__labHTML = () => newHost.innerHTML;

/** Scroll both panels to the same fraction of their height. */
window.__labScrollTo = (fraction = 0.5) => {
  for (const host of [oldHost, newHost]) {
    const max = Math.max(0, host.scrollHeight - host.clientHeight);
    host.scrollTop = Math.round(max * Math.max(0, Math.min(1, Number(fraction))));
  }
  return { old: oldHost.scrollTop, new: newHost.scrollTop };
};

/** Measure one element by its key in the new panel, for a geometry check. */
window.__labBox = (key) => {
  const node = newHost.querySelector(`[data-key="${key}"]`) || newHost.querySelector(`[data-k="${key}"]`);
  if (!node) return null;
  const r = node.getBoundingClientRect();
  const box = newHost.getBoundingClientRect();
  return { top: Math.round(r.top - box.top), height: Math.round(r.height), open: 'open' in node ? node.open : null };
};
