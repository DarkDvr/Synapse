// Watch the sign-in window, and take it away when the session is real — or, in a
// hand-off, wait for the operator to close it.
//
// The operator's complaint was not the sign-in, it was what came after: the window sat
// there with no way to know whether the login had taken or what to do next (11 Nov). It
// polls the page it is already standing on, and when the page stops asking to be signed
// into — no password box, no sign-in route, twice in a row, loaded — it hides the window
// and tells the caller. With `autoHide: false` it reports the page and keeps watching for
// the close instead: a bot check has no password box, and hiding it mid-challenge would be
// sabotage (22 Nov).
//
// Two polls rather than one because a two-step sign-in (email, then password) hides the
// password box between steps, and closing the window in that gap would be sabotage.
import { looksUnconfirmed } from './signin.js';

/**
 * Is this page a signed-in one? The same two signals the rest of SynaBrowse uses: no
 * password box, and an address that is not a sign-in route.
 */
export function signedInNow(state) {
  if (!state || !state.url) return false;
  if (state.ready && state.ready !== 'complete') return false;
  // A page with a visible "Log in"/"Sign in" control is still a guest page, even when it
  // has no password box and its address is not a login route (Nexus's homepage, 22 Nov).
  // A bot check is not a session either; the operator must clear it first.
  if (state.signInLink || state.wall) return false;
  return !looksUnconfirmed(state.url, state.passwords);
}

/**
 * Poll until the session looks real, the window goes, or the clock runs out.
 *
 * `onSignedIn(url)` is called once, after the window has been closed by `browser.stop()`
 * when `autoHide` is on; with `autoHide: false` the window is left for the operator to
 * close, and `onGone` is the ending. `onGone(why)` is called when the window disappears
 * first (the operator closed it) or the wait ran out — never as a success by itself,
 * because nothing proved a session.
 */
export function watchForSignIn(browser, { intervalMs = 2000, timeoutMs = 10 * 60 * 1000, autoHide = true, onSignedIn = null, onGone = null, log = null } = {}) {
  let stopped = false;
  let streak = 0;
  let reported = false;
  let lastState = null;
  const began = Date.now();

  const finish = (why, state = lastState) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(deadline);
    // Closing the window after the login page has gone is still a sign-in, even if the
    // second confirming poll never landed. Without this, a quick close recorded nothing
    // and the operator was told their session had failed when it had not (24 Nov).
    if (why === 'closed' && !reported && state && signedInNow(state)) {
      reported = true;
      log?.info?.(`browser: signed in at ${state.url} — the window closed before the second poll`);
      try { onSignedIn?.(state.url); } catch { /* a listener must not break the page */ }
      return;
    }
    log?.info?.(`browser: watch ended (${why}) after ${Date.now() - began}ms`);
    onGone?.(why);
  };

  const tick = async () => {
    if (stopped) return;
    let state = null;
    try {
      state = await browser.pageState();
    } catch (err) {
      // No page to ask: the window is gone. That is an ending, not a failure.
      finish('closed');
      return;
    }
    lastState = state;
    if (signedInNow(state)) {
      streak += 1;
      if (streak < 2) return;
      if (!reported) {
        reported = true;
        log?.info?.(`browser: signed in at ${state.url} — ${autoHide ? 'hiding the window for the operator' : 'waiting for the operator to close the window'}`);
        try { onSignedIn?.(state.url); } catch { /* a listener must not break the page */ }
        if (autoHide) {
          stopped = true;
          clearInterval(timer);
          clearTimeout(deadline);
          // Hide, do not close: the model is usually still mid-turn and its page must survive.
          try { await browser.hideWindow(); } catch { /* the window may already be gone */ }
          return;
        }
      }
      return;
    }
    streak = 0;
  };

  const timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  const deadline = setTimeout(() => finish('timeout'), timeoutMs);
  timer.unref?.();
  deadline.unref?.();
  return () => { stopped = true; clearInterval(timer); clearTimeout(deadline); };
}
