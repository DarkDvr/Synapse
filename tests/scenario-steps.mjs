// A scenario step, applied to the page's state.
//
// Shared by the two ways a scenario is played: tests/scenario-player.mjs (Node, against the
// renderer with no browser) and tests/browser/lab.js (a real browser, for the scenes that
// need geometry). It is browser-safe on purpose — no node imports, no DOM.
import { dirKey } from '../web/run-view.js';

/** The page state a chat render reads. Reset before every scenario. */
export function resetState(state) {
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
  state.handover = null;
}

/**
 * A scenario says `"now-5000"` where a real timestamp matters — a download is only shown
 * for ten minutes after it ends, and a message's window is measured from its own clock.
 * Everything else is a plain number.
 */
export const stamp = (value) => {
  if (typeof value !== 'string' || !value.startsWith('now')) return value;
  return Date.now() + (Number(value.slice(3)) || 0);
};

/** Apply one step. Throws on a step the scenarios do not define — a silent no-op would pass. */
export function applyStep(state, step) {
  switch (step.do) {
    case 'messages':
      state.messages = (step.messages || []).map((m) => ({ ...m, created: stamp(m.created) }));
      return;
    case 'grow': {
      // A text part gaining words, the way a delta arrives: the same part, a longer string.
      const message = (state.messages || []).find((m) => m.id === step.id);
      if (!message) throw new Error(`scenario: no message "${step.id}" to grow`);
      const parts = message.parts || [];
      const part = parts.find((p) => p.key && p.key === step.part) || parts[Number(step.part)];
      if (!part) throw new Error(`scenario: no part "${step.part}" in "${step.id}"`);
      part.text = String(part.text || '') + String(step.delta || '');
      return;
    }
    case 'parts': {
      const message = (state.messages || []).find((m) => m.id === step.id);
      if (!message) throw new Error(`scenario: no message "${step.id}" to grow`);
      message.parts = [...(message.parts || []), ...(step.add || [])];
      return;
    }
    case 'trace':
      state.traces.set(step.trace.key, step.trace);
      return;
    case 'trace-update': {
      const trace = state.traces.get(step.key);
      if (!trace) throw new Error(`scenario: no trace "${step.key}" to update`);
      Object.assign(trace, step.patch || {});
      return;
    }
    case 'note': {
      const trace = state.traces.get(step.key);
      if (!trace) throw new Error(`scenario: no trace "${step.key}" for a note`);
      trace.notes = [...(trace.notes || []), step.note];
      return;
    }
    case 'download': {
      const d = {
        ...step.download,
        startedAt: stamp(step.download.startedAt),
        endedAt: stamp(step.download.endedAt),
      };
      state.downloads.set(`${dirKey(d.dir)}\u0000${d.id}`, d);
      return;
    }
    case 'alarm':
      state.alarms.push({ ...step.alarm, at: stamp(step.alarm.at) });
      return;
    case 'lease':
      state.leases.set(step.key, step.lease);
      return;
    case 'form':
      state.forms = step.form ? [step.form] : [];
      return;
    case 'permission':
      state.permissions = step.permission ? [step.permission] : [];
      return;
    case 'handover':
      state.handover = step.handover || null;
      return;
    case 'open':
      state.open.add(step.key);
      return;
    case 'close':
      state.open.delete(step.key);
      return;
    case 'stream': {
      // A step that forgets the key keeps the one already there: the pane belongs to the
      // session's own trace, and a missing key used to blank it and take the old chat's
      // pane off the screen in the middle of a turn.
      if (step.key) state.sessionTrace.key = step.key;
      const stream = state.sessionTrace.stream || { kind: 'think', text: '', offset: 0 };
      stream.kind = step.kind || 'think';
      stream.text += step.delta || '';
      state.sessionTrace.stream = stream;
      return;
    }
    // The pane's own switch — the operator's click on its ▾. It lives on the session's trace,
    // the same place a worker's trace keeps its own (web/thinking-pane.js).
    case 'stream-flag':
      Object.assign(state.sessionTrace, step.patch || {});
      return;
    case 'render':
      return;
    // Where the reader's own selection is, is not state: it is the browser's. The lab
    // (tests/browser/lab.js) makes the selection; a player with no DOM has nothing to do.
    case 'select':
      return;
    default:
      throw new Error(`scenario: unknown step "${step.do}"`);
  }
}
