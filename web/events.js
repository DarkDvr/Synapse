// The engine's event names, in one place.
//
// They used to be string literals in six files — `'session.step.started'` here,
// `'session.retry.scheduled'` there — and a typo is the quietest bug in this
// codebase: the handler simply never runs, and the only symptom is a feature that
// does nothing. `tests/events.test.mjs` now fails on a bare `'session.…'` literal
// anywhere outside the adapter.
//
// This file lives in `web/` because both runtimes need it: the server imports it
// from `../web/events.js`, and the page gets it as a module beside `app.js`. One
// file, no copy to drift.
export const EV = {
  automation: 'session.automation',
  mode: 'session.mode',
  status: 'session.status',
  idle: 'session.idle',

  compactionStarted: 'session.compaction.started',
  compactionEnded: 'session.compaction.ended',
  compactionFailed: 'session.compaction.failed',

  executionStarted: 'session.execution.started',
  executionSucceeded: 'session.execution.succeeded',
  executionFailed: 'session.execution.failed',
  executionInterrupted: 'session.execution.interrupted',

  retryScheduled: 'session.retry.scheduled',
  stepStarted: 'session.step.started',
  stepEnded: 'session.step.ended',

  textDelta: 'session.text.delta',
  textEnded: 'session.text.ended',
  reasoningDelta: 'session.reasoning.delta',
  reasoningEnded: 'session.reasoning.ended',

  toolCalled: 'session.tool.called',
  toolInputStarted: 'session.tool.input.started',
  toolSuccess: 'session.tool.success',
  toolFailed: 'session.tool.failed',
  toolInputEnded: 'session.tool.input.ended',

  usageUpdated: 'session.usage.updated',
};

/** Every execution ending, in one test: the turn is over however it went. */
export const EXECUTION_ENDED = [EV.executionSucceeded, EV.executionFailed, EV.executionInterrupted];

/** Is this event one of the ways a turn ends? */
export const turnEnded = (type) => EXECUTION_ENDED.includes(type);

/** The prefix tests use to find a bare literal that should have been a name. */
export const PREFIX = 'session.';

/** `session.text.delta` -> `text.delta`, for the event chip and the age line. */
export const shortEvent = (type) => String(type || '').split(PREFIX).join('');
