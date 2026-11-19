// Play a chat scenario against the page's own renderer, with no server and no browser.
//
// A scenario is the conversation as the page is given it: messages arriving, a trace
// growing, the operator opening a fold, the next render. The player applies each step to
// the page's state and calls the same entry point the app calls, so what comes out is what
// the operator would have seen.
//
// Why this exists: the chat rewrite has to prove two things — the new renderer draws the
// same conversation, and it keeps the promises the old one breaks. Both are assertions
// over the frames this returns (tests/scenario.test.mjs holds the cases; the scenario
// files are in tests/scenarios/). Fed by hand now, by a recording later.
import { installPage } from './fake-page.mjs';

/** The page state a transcript render reads. Reset before every scenario. */
function reset(state) {
  state.sessionId = 'ses_scenario';
  state.view = 'session';
  state.projects = [{ id: 'p1', name: 'Scenario', directory: 'F:/scenario', sessions: [{ id: 'ses_scenario' }] }];
  state.messages = [];
  state.forms = [];
  state.permissions = [];
  state.alarms = [];
  state.traces = new Map();
  state.leases = new Map();
  state.downloads = new Map();
  state.sessionTrace = { key: '', stream: null };
  state.open = new Set();
  state.renderSig = '';
  state.renderPaused = false;
  state.decisionSeq = 0;
  state.downloadSeq = 0;
  state.liveTool = null;
  state.compacting = false;
}

function apply(state, step) {
  switch (step.do) {
    case 'messages':
      state.messages = step.messages || [];
      break;
    case 'parts': {
      // A turn gaining a part: the engine writes a new reasoning block, a tool call, a
      // paragraph. The blocks that were there keep their identity, which is what makes an
      // open fold testable as the turn grows past the point where it would be archived.
      const m = (state.messages || []).find((x) => x.id === step.id);
      if (!m) throw new Error(`scenario: no message "${step.id}" to grow`);
      m.parts = [...(m.parts || []), ...(step.add || [])];
      break;
    }
    case 'trace':
      state.traces.set(step.trace.key, step.trace);
      break;
    case 'trace-update': {
      const trace = state.traces.get(step.key);
      if (!trace) throw new Error(`scenario: no trace "${step.key}" to update`);
      Object.assign(trace, step.patch || {});
      break;
    }
    case 'note': {
      const trace = state.traces.get(step.key);
      if (!trace) throw new Error(`scenario: no trace "${step.key}" for a note`);
      trace.notes = [...(trace.notes || []), step.note];
      break;
    }
    case 'reasons': {
      // A worker's thinking gaining a block: the trace's own folds move past the point where
      // the oldest would be rolled into "Older entries".
      const trace = state.traces.get(step.key);
      if (!trace) throw new Error(`scenario: no trace "${step.key}" to think in`);
      trace.reasons = [...(trace.reasons || []), ...(step.add || [])];
      break;
    }
    case 'alarm':
      state.alarms.push(step.alarm);
      break;
    case 'lease':
      state.leases.set(step.key, step.lease);
      break;
    case 'open':
      state.open.add(step.key);
      break;
    case 'close':
      state.open.delete(step.key);
      break;
    case 'stream': {
      state.sessionTrace.key = step.key;
      const stream = state.sessionTrace.stream || { kind: 'think', text: '', offset: 0 };
      stream.kind = step.kind || 'think';
      stream.text += step.delta || '';
      state.sessionTrace.stream = stream;
      break;
    }
    case 'render':
      break;
    default:
      throw new Error(`scenario: unknown step "${step.do}"`);
  }
}

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

  reset(state);
  const el = page.el('transcript');
  const frames = [];
  for (const [index, step] of (scenario.steps || []).entries()) {
    apply(state, step);
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
