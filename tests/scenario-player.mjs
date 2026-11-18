// Play a chat scenario against the page's own renderer, with no server and no browser.
//
// A scenario is the conversation as the page is given it: messages arriving, a trace
// growing, the operator opening a fold, the next render. The player applies each step
// (tests/scenario-steps.mjs, shared with the browser lab) and calls the same entry point
// the app calls, so what comes out is what the operator would have seen.
//
// Why this exists: the chat rewrite has to prove two things — the new renderer draws the
// same conversation, and it keeps the promises the old one breaks. Both are assertions
// over the frames this returns (tests/scenario.test.mjs holds the cases; the scenario
// files are in tests/scenarios/). Fed by hand now, by a recording later.
import { installPage } from './fake-page.mjs';
import { resetState, applyStep } from './scenario-steps.mjs';

/**
 * Play a scenario and return every frame it drew.
 *
 * @param {{name?: string, steps: Array<object>}} scenario
 * @returns {Promise<{ el: object, state: object, frames: Array<{ step: number, do: string, html: string }> }>}
 */
export async function play(scenario) {
  const page = installPage();
  const { state } = await import('../web/state.js');
  const { renderTranscript, transcriptWiring } = await import('../web/transcript.js');
  const { chatScrollWiring } = await import('../web/chat-scroll.js');
  const { tracesWiring } = await import('../web/traces.js');

  // The subset of app.js's boot wiring a transcript render needs.
  transcriptWiring({
    renderRoleActivity() {},
    mountAskPost() {},
    renderPermissions: () => '',
    compactPostOf: () => null,
  });
  chatScrollWiring({ renderTranscript, traceOf: () => null, currentRun: () => null, askHost: () => null });
  tracesWiring({ renderTranscript });

  resetState(state);
  const el = page.el('transcript');
  const frames = [];
  for (const [index, step] of (scenario.steps || []).entries()) {
    applyStep(state, step);
    // Opening a fold is not a render: the operator's click does not redraw the chat.
    if (step.do === 'open' || step.do === 'close') continue;
    // A `render` step means "the app draws now" — a poll, a delta, a new message. The
    // renderer's own "nothing changed" guard would otherwise skip it, and the scenario
    // would be testing the skip instead of the drawing.
    state.renderSig = '';
    renderTranscript();
    frames.push({ step: index, do: step.do, html: el.innerHTML });
  }
  return { el, state, frames };
}

/** The frames from the step that opened `key` onwards. */
export function framesAfterOpen(frames, key) {
  const at = frames.findIndex((f) => f.html.includes(`data-k="${key}"`));
  return at < 0 ? [] : frames.slice(at);
}

/** Is the fold with this key drawn open in a frame's markup? */
export function foldOpen(html, key) {
  const tag = new RegExp(`<details[^>]*data-k="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`).exec(String(html || ''));
  return Boolean(tag && /\sopen(\s|>)/.test(tag[0]));
}
