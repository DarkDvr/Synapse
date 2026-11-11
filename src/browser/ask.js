// A sign-in is a permission, not a surprise.
//
// The browser browses on its own; when a page needs a login, the harness **asks** first,
// through the same card the screen lease uses: Allow, Reject, Reject With Reason, Stop Run.
// Only an Allow opens a window — on the monitor the operator is looking at, normal and
// focused, with no time limit. A session created there is recorded and the window goes; a
// window closed without one counts as a Reject.
//
// Why a card and not a window that appears: the operator met a minimised window on the
// wrong monitor, a flash of a restored one, focus taken from their own work, and a chime
// with nothing to answer (11–12 Nov). A card is answerable, refuses cleanly, and never
// arrives uninvited.
//
// While an ask is open the stall clock is suspended (`holding()`), because the wait is the
// operator's, not the model's — and a run must not be called stalled while it is waiting
// for a person.
export function createBrowserAsks({ notify = null, log = null } = {}) {
  const pending = new Map();

  /** Ask the operator. Resolves `{ allow, message }` — never times out. */
  function ask({ host, url, what = '', role = 'architect', task = '' } = {}) {
    const id = `browser_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const entry = {
      id,
      host: String(host || ''),
      url: String(url || ''),
      what: String(what || ''),
      role,
      task,
      at: Date.now(),
    };
    const promise = new Promise((resolve) => { entry.resolve = resolve; });
    pending.set(id, entry);
    log?.info?.(`browser ask: ${entry.host || entry.url} — ${entry.what || 'sign in'}`);
    notify?.({ kind: 'browser-ask', type: 'browser.ask', id, host: entry.host, url: entry.url, what: entry.what, at: entry.at });
    return promise;
  }

  /** The operator answered. An unknown id is a card that has already gone. */
  function answer(id, { allow = false, message = '' } = {}) {
    const entry = pending.get(id);
    if (!entry) return { ok: false, error: 'that ask is not open' };
    pending.delete(id);
    notify?.({ kind: 'browser-ask', type: 'browser.answered', id, allow: Boolean(allow), message: String(message || ''), at: Date.now() });
    entry.resolve({ allow: Boolean(allow), message: String(message || '') });
    return { ok: true };
  }

  /** The asks as the permission card needs them: the same fields, one extra scope. */
  function list() {
    return [...pending.values()].map(({ resolve, ...entry }) => ({
      requestId: entry.id,
      scope: 'browser',
      action: 'browser',
      role: entry.role,
      task: entry.task,
      resources: entry.url ? [entry.url] : [],
      reason: entry.what
        ? `${String(entry.what).replace(/\.?$/, '.')} Opening the window is your decision, and a sign-in you finish is kept in SynaBrowse's own profile.`
        : 'Sign in to this site in a window of your own. A sign-in you finish is kept in SynaBrowse\'s own profile.',
      browserHost: entry.host,
      browserUrl: entry.url,
      at: entry.at,
    }));
  }

  /** Is anything waiting on the operator? The stall clock is suspended while it is. */
  function holding() {
    return pending.size > 0;
  }

  return { ask, answer, list, holding, get size() { return pending.size; } };
}

// ── the one registry this process shares ────────────────────────
// Created by the API (it owns the notify channel), read by the runner: a sign-in ask is a
// wait on a person, and the stall clock must not call it a stall (12 Nov).
let shared = null;

export function configureBrowserAsks(options) {
  shared = createBrowserAsks(options);
  return shared;
}

export function browserAsks() {
  return shared;
}

/** Is the operator being asked something right now? */
export function browserAskHolding() {
  return Boolean(shared?.holding());
}
