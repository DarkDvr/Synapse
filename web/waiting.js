// The one line that says what a waiting turn is doing.
//
// The page gets facts from several places — the engine's own events, a local
// server's live metrics, a tool that is running — and they are not all available
// for every model. This module is the one place that decides which fact is the
// best description of the moment. The rules are deliberately small:
//
//   * a fresher, more specific fact wins;
//   * a fact nobody supplies is simply absent, never invented;
//   * a turn's end clears the line.
//
// No DOM, no fetch, no provider names: `tests/waiting.test.mjs` can ask what the
// line says for every combination without a page.

/** The states the line can be in. Kept as strings: the state is data, not markup. */
export const WAIT = {
  idle: 'idle',
  connecting: 'connecting',
  connected: 'connected',
  waiting: 'waiting',
  loading: 'loading',
  queued: 'queued',
  prefill: 'prefill',
  thinking: 'thinking',
  retry: 'retry',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const clean = (text, max = 70) =>
  String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

const count = (n) => String(Math.max(0, Math.round(num(n)))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const seconds = (n) => {
  const s = Math.floor(num(n));
  return s >= 1 ? ` ${s}s` : '';
};

/**
 * A turn just started and the engine accepted it.
 *
 * A local server gets `connecting` until its metrics answer or fail: that is a
 * real connection being attempted. A cloud model gets `waiting`, because no
 * source can tell us more than "the request is with the provider".
 */
export function waitBegin({ sessionId = '', at = Date.now(), local = false } = {}) {
  return {
    phase: local ? WAIT.connecting : WAIT.waiting,
    at,
    since: at,
    sessionId: String(sessionId || ''),
    detail: '',
    attempt: 0,
    retryAt: 0,
    read: 0,
    total: 0,
    elapsed: 0,
  };
}

/** The engine has begun generating: the prompt is behind it. */
export function waitStep(wait, at = Date.now()) {
  if (!wait || wait.phase === WAIT.idle) return wait || null;
  return {
    ...wait,
    phase: WAIT.thinking,
    at,
    detail: '',
    retryAt: 0,
    read: 0,
    total: 0,
    elapsed: 0,
  };
}

/** The first byte of output; the same boundary as a step for the line's purpose. */
export const waitToken = waitStep;

/**
 * A provider attempt failed and the engine will try again.
 *
 * `retryAt` is optional: an engine that does not say when the retry is due still
 * gets the reason, which is the part the operator can act on.
 */
export function waitRetry(wait, { at = Date.now(), retryAt = 0, detail = '', attempt = 0 } = {}) {
  if (!wait || wait.phase === WAIT.idle) return wait || null;
  return {
    ...wait,
    phase: WAIT.retry,
    at,
    retryAt: Number(retryAt) > at ? Number(retryAt) : 0,
    detail: clean(detail),
    attempt: num(attempt),
  };
}

/**
 * A live metric from a local server.
 *
 * The shape is already normalised by `src/provider-live.js`; this function only
 * decides whether it is more specific than what it has. A `retry` or `thinking`
 * state is not overwritten by a metric that is a moment behind the engine.
 */
export function waitMetrics(wait, metrics, at = Date.now()) {
  if (!wait || wait.phase === WAIT.idle) return wait || null;
  if (wait.phase === WAIT.retry || wait.phase === WAIT.thinking) return wait;

  // No answer, or the route does not exist: stop claiming a connection we cannot
  // prove. The engine events still carry the turn; the line falls back to the
  // honest "waiting for the model".
  if (!metrics || metrics.ok === false || metrics.reachable === false) {
    return {
      ...wait,
      phase: WAIT.waiting,
      at,
      read: 0,
      total: 0,
      elapsed: 0,
    };
  }

  const state = String(metrics.state || '').toLowerCase();
  const read = num(metrics.read);
  const total = num(metrics.total);
  const generated = num(metrics.generated);
  let phase;
  if (/load/.test(state)) phase = WAIT.loading;
  else if (/queue|wait/.test(state)) phase = WAIT.queued;
  else if (read > 0 && total > 0 && read < total) phase = WAIT.prefill;
  else if (/prefill|prompt|read/.test(state) && total > 0) phase = WAIT.prefill;
  else if (/generat|think|decode/.test(state) || generated > 0) phase = WAIT.thinking;
  else if (read > 0 && total > 0) phase = WAIT.prefill;
  else phase = WAIT.connected;

  return {
    ...wait,
    phase,
    at,
    read,
    total,
    elapsed: num(metrics.elapsed),
  };
}

/** The turn ended; nothing may survive into the next one. */
export function waitEnd() {
  return null;
}

/**
 * The line, for one state.
 *
 * Only the latest state is ever returned. A fast sequence is allowed to flash by;
 * the line is for the moment that is stuck, not a history of the turn.
 */
export function waitingText(wait, now = Date.now()) {
  if (!wait || wait.phase === WAIT.idle) return '';
  const age = Math.max(0, Math.floor((Number(now) - (Number(wait.at) || Number(now))) / 1000));
  const elapsed = seconds(age);

  switch (wait.phase) {
    case WAIT.connecting:
      return `Connecting…${elapsed}`;
    case WAIT.connected:
      return `Connected — waiting for the prompt…${elapsed}`;
    case WAIT.loading:
      return `Model loading…${elapsed}`;
    case WAIT.queued:
      return `Queued…${elapsed}`;
    case WAIT.prefill: {
      const read = num(wait.read);
      const total = num(wait.total);
      const progress = read > 0 && total > 0 ? ` ${count(read)} / ${count(total)}` : '';
      const took = seconds(wait.elapsed || age);
      return `Reading prompt${progress}…${took}`;
    }
    case WAIT.retry: {
      const left = Number(wait.retryAt) > now ? Math.ceil((Number(wait.retryAt) - now) / 1000) : 0;
      const when = left > 0 ? `Retrying in ${left}s` : 'Retrying…';
      return wait.detail ? `${when} — ${clean(wait.detail)}` : when;
    }
    case WAIT.thinking:
      return `Thinking…${elapsed}`;
    case WAIT.waiting:
    default:
      return `Waiting for the model…${elapsed}`;
  }
}
