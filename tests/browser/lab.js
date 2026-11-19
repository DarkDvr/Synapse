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
// The two panels, by the name a scenario or a check calls them.
const panels = { old: oldHost, new: newHost };
const view = createChatView(newHost, {
  // A submission is the app's to send; the lab just records it.
  onSubmit: (form, answer) => {
    window.__submitted = { form: form.id, answer };
  },
  // Opening a card is the page's business, not the renderer's: the state keeps the answer.
  onToggle: (key, open) => {
    if (open) state.open.add(key);
    else state.open.delete(key);
  },
});

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

const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/**
 * The first thing visible in a panel, and where it sits in the *window*.
 *
 * The viewport offset is the honest measure: the reader is looking at a place on the
 * screen, and if that place moves, the words they were reading moved. A content offset
 * changes whenever anything above grows — that is geometry, not movement.
 */
const anchorOf = (host) => {
  const box = host.getBoundingClientRect();
  const top = box.top + 2;
  for (const node of host.querySelectorAll('.msg, .trace, .trace-line, .tool-card')) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom <= top) continue;
    return { text: squash(node.textContent).slice(0, 40), at: Math.round(rect.top - box.top) };
  }
  return null;
};

/** How far that same text moved on screen since the anchor was taken. Zero is the answer. */
const movedSince = (host, anchor) => {
  if (!anchor) return null;
  const box = host.getBoundingClientRect();
  for (const node of host.querySelectorAll('.msg, .trace, .trace-line, .tool-card')) {
    if (!squash(node.textContent).startsWith(anchor.text)) continue;
    return Math.round(node.getBoundingClientRect().top - box.top - anchor.at);
  }
  return null;
};

/**
 * The conversation's words, with the controls left out.
 *
 * The pane's "New words ↓" chip is a button, not something the conversation says, and it is
 * hidden unless it is needed — `textContent` counts it anyway, and only the new renderer has
 * one. Taking the controls out is what makes the two panels comparable as text at all.
 */
const words = (host) => {
  const copy = host.cloneNode(true);
  for (const control of copy.querySelectorAll('.think-new, .msg-reuse')) control.remove();
  return copy.textContent.replace(/\s+/g, ' ').trim();
};

const shape = (host) => ({
  text: words(host),
  posts: host.querySelectorAll('.msg').length,
  cards: host.querySelectorAll('.tool-card').length,
  folds: host.querySelectorAll('details').length,
  // Heights are the whole point of the pane check: a fixed window keeps them still.
  postHeights: [...host.querySelectorAll('.msg')].map((n) => Math.round(n.getBoundingClientRect().height)),
  paneHeights: [...host.querySelectorAll('.trace-flow-view')].map((n) => Math.round(n.getBoundingClientRect().height)),
  scroll: { top: Math.round(host.scrollTop), height: host.scrollHeight, client: host.clientHeight },
  entering: host.querySelectorAll('.is-enter').length,
  reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  hint: Boolean(host.querySelector('.think-new:not([hidden])')),
  // The pane's own words, and whether it is folded to its one-line shape.
  pane: host.querySelector('.trace-flow-body')?.textContent || '',
  paneShut: Boolean(host.querySelector('.think-line')),
});

/**
 * A range over `words` inside a panel, built from that panel's own text nodes.
 *
 * It is what a drag over the words produces, not a stand-in for one, so a renderer that
 * rebuilds its markup loses it and a renderer that writes in place keeps it. Null when the
 * words are not there, which is a scenario mistake worth failing on rather than ignoring.
 */
function rangeFor(host, words) {
  const needle = String(words || '');
  if (!needle) return null;
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let all = '';
  while (walker.nextNode()) {
    const node = walker.currentNode;
    nodes.push({ node, at: all.length, ends: all.length + node.data.length });
    all += node.data;
  }
  const start = all.indexOf(needle);
  if (start < 0) return null;
  const pointAt = (offset) => {
    for (const entry of nodes) {
      if (offset >= entry.at && offset <= entry.ends) return { node: entry.node, offset: offset - entry.at };
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last.node, offset: last.node.data.length } : null;
  };
  const a = pointAt(start);
  const b = pointAt(start + needle.length);
  if (!a || !b) return null;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

/** Select the words in a panel, as the operator would. */
function select(words, panel = 'new') {
  const range = rangeFor(panels[panel] || newHost, words);
  if (!range) return false;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return sel.toString() === String(words);
}

/** What is selected now, and which panel is holding it. */
function selectionNow() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return { text: '', panel: '' };
  const node = sel.anchorNode;
  // A detached node still answers `toString()` with the words it held, but nothing is
  // highlighted any more and the operator cannot copy it: a selection whose tree left the
  // document is gone, whatever it says.
  const live = Boolean(node && node.isConnected);
  const panel = !live ? '' : newHost.contains(node) ? 'new' : oldHost.contains(node) ? 'old' : '';
  return { text: sel.toString(), panel };
}


function frame(step, model, picked) {
  // Where the reader is, before anything moves.
  const anchorOld = anchorOf(oldHost);
  const anchorNew = anchorOf(newHost);
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
    old: { text: a.text.length, posts: a.posts, cards: a.cards, folds: a.folds, scroll: a.scroll, postHeights: a.postHeights, paneHeights: a.paneHeights, pane: a.pane, paneShut: a.paneShut, entering: a.entering, hint: a.hint, reducedMotion: a.reducedMotion },
    new: { text: b.text.length, posts: b.posts, cards: b.cards, folds: b.folds, scroll: b.scroll, postHeights: b.postHeights, paneHeights: b.paneHeights, pane: b.pane, paneShut: b.paneShut, entering: b.entering, hint: b.hint, reducedMotion: b.reducedMotion },
    // The same characters: a block join is a space in one renderer and a newline in the
    // other, which reads the same and is not a difference worth chasing.
    sameText: a.text.replace(/\s+/g, '') === b.text.replace(/\s+/g, ''),
    // A change above the reader must not move the line they are on. Zero is the answer.
    moved: { old: movedSince(oldHost, anchorOld), new: movedSince(newHost, anchorNew) },
    // What the operator had selected, and whether it is still there after the draw.
    picked,
    selection: selectionNow(),
  };
}

/**
 * Play a scenario file by name and answer every frame it drew.
 * `only` narrows it to the first N renders, for a shorter run.
 * `selectPanel` overrides which panel a `select` step picks in: the promise is a comparison,
 * so the same scenario is played once against each renderer.
 */
window.__labRun = async (name, only, selectPanel) => {
  const res = await fetch(`/tests/scenarios/${name}.json`);
  if (!res.ok) throw new Error(`no scenario "${name}" (${res.status})`);
  const scenario = await res.json();
  resetState(state);
  view.update(buildChat(state));
  const frames = [];
  let picked = null;
  for (const [i, step] of scenario.steps.entries()) {
    if (step.do === 'scrollTo') {
      window.__labScrollTo(step.fraction);
      continue;
    }
    if (step.do === 'scrollPane') {
      const pane = newHost.querySelector('.trace-flow-view');
      if (pane) pane.scrollTop = Math.round((pane.scrollHeight - pane.clientHeight) * Number(step.fraction || 0));
      continue;
    }
    if (step.do === 'select') {
      const panel = selectPanel || step.panel || 'new';
      if (!select(step.text, panel)) throw new Error(`no text "${step.text}" to select in the ${panel} panel`);
      picked = { panel, text: String(step.text) };
      continue;
    }
    applyStep(state, step);
    if (step.do === 'open' || step.do === 'close') continue;
    frames.push(frame(i, buildChat(state), picked));
    if (Number(only) && frames.length >= Number(only)) break;
  }
  return frames;
};

/** The page state, for a probe that has to know why a frame came out as it did. */
window.__labState = () => state;

/** The full text of both panels, for a diff when they disagree. */
window.__labTexts = () => ({
  old: oldHost.textContent.replace(/\s+/g, ' ').trim(),
  new: newHost.textContent.replace(/\s+/g, ' ').trim(),
});

/** The markup of the new panel, for a check that needs to read rather than measure. */
window.__labHTML = () => newHost.innerHTML;

/** Rebuild the model and paint again, without resetting the scenario. */
window.__labUpdate = () => {
  const model = buildChat(state);
  state.renderSig = '';
  renderTranscript();
  view.update(model);
  return {
    form: Boolean(model.form),
    fields: newHost.querySelectorAll('.ask-field').length,
    note: newHost.querySelector('.ask-head-note')?.textContent || '',
    progress: newHost.querySelector('[data-ask-progress]')?.textContent || '',
    panelAtEnd: Boolean(newHost.lastElementChild && newHost.lastElementChild.classList.contains('ask-panel')),
  };
};

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

/**
 * The promises that need a browser, as cases that fail rather than as numbers to read.
 *
 * `scripts/chat-lab.mjs --check` runs this and exits non-zero when a case fails, so a
 * promise that quietly stopped holding cannot pass for a photograph that still looks right.
 * Wherever the old chat is the thing being beaten, the case is a comparison with it: that is
 * what makes the answer mean something.
 */
window.__labCheck = async () => {
  const cases = [];
  const caseFor = (name, ok, detail) => cases.push({ name, ok: Boolean(ok), detail });

  // The same conversation, drawn twice: the words have to come out the same, in every frame,
  // or one renderer is reading the model differently from the other. A form is left out on
  // purpose — the lab's old renderer is given a do-nothing `mountAskPost`, so the panel is
  // drawn by the new one only and the two are not comparable until the app wires both.
  for (const name of ['S1-folds', 'download-placement', 'alarm-split', 'anchor', 'stream-burst', 'pane-scroll', 'pane-collapse']) {
    const frames = await window.__labRun(name);
    const off = frames.filter((f) => !f.sameText);
    caseFor(
      `both renderers draw ${name} the same`,
      frames.length > 0 && !off.length,
      frames.length ? `${frames.length} frame(s), ${off.length} with different words` : 'no frames were drawn',
    );
  }

  // The pane's two shapes are two different elements, and the operator's switch decides
  // which one is drawn. Folding must not be the end of the words: the same text has to come
  // back, and the delta after it has to append to that text rather than start a second box.
  const pane = await window.__labRun('pane-collapse');
  const first = pane.find((f) => f.new.paneHeights.length && f.new.pane.length) || null;
  const folded = pane.find((f) => f.new.paneShut) || null;
  const reopened = folded ? pane.slice(pane.indexOf(folded) + 1).find((f) => f.new.pane.length) || null : null;
  const grown = pane.at(-1);
  const shorter = first && folded ? folded.new.postHeights[0] < first.new.postHeights[0] : false;
  const cameBack = Boolean(first && reopened && reopened.new.pane === first.new.pane);
  const appended = Boolean(first && grown && grown.new.pane.startsWith(first.new.pane) && grown.new.pane.length > first.new.pane.length);
  caseFor(
    'the pane folds to one line and comes back with the same words',
    Boolean(first && folded && reopened && shorter && cameBack && appended),
    !first || !folded || !reopened
      ? `${pane.length} frames, no fold to one line and back`
      : `${first.new.postHeights[0]}px → ${folded.new.postHeights[0]}px folded → ${reopened.new.postHeights[0]}px, ` +
        `${first.new.pane.length} characters → ${reopened.new.pane.length} back → ${grown.new.pane.length} with the next delta`,
  );

  // A selection inside a post, under the words that arrive after it. The new renderer writes
  // the new words into the paragraph that is already there; the old one either replaces its
  // markup and loses the selection, or stops drawing altogether — `web/transcript.js` pauses
  // the render while a selection is in the chat, so the operator is left reading an answer
  // that is no longer the answer. It cannot do both, and that is the case.
  const selectionRun = async (panel) => {
    const frames = await window.__labRun('selection', 0, panel);
    const at = frames.findIndex((f) => f.picked);
    return at < 0 ? [] : frames.slice(at);
  };
  const holds = (f) => Boolean(f.picked) && f.selection.text === f.picked.text && f.selection.panel === f.picked.panel;

  const fresh = await selectionRun('new');
  const kept = fresh.filter(holds).length;
  const drew = fresh.length > 1 && fresh.at(-1).new.text > fresh[0].new.text;
  caseFor(
    'the new renderer keeps the selection and draws the delta',
    fresh.length >= 2 && kept === fresh.length && drew,
    fresh.length < 2
      ? `only ${fresh.length} frame(s) after the selection`
      : `held in ${kept} of ${fresh.length} frames, ${fresh[0].new.text} → ${fresh.at(-1).new.text} characters`,
  );

  const past = await selectionRun('old');
  const wasKept = past.filter(holds).length;
  const stalled = past.length > 1 && past.at(-1).old.text === past[0].old.text;
  caseFor(
    'the old renderer cannot keep the selection and draw the delta',
    past.length >= 2 && (wasKept < past.length || stalled),
    past.length < 2
      ? `only ${past.length} frame(s) after the selection`
      : wasKept < past.length
        ? `lost the selection in ${past.length - wasKept} of ${past.length} frames`
        : `kept it by not drawing: the post stayed at ${past[0].old.text} characters while the conversation reached ${past.at(-1).new.text}`,
  );

  return { cases, pass: cases.every((c) => c.ok) };
};
