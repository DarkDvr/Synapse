// Watch the sign-in window, and take it away the moment the session is real.
//
// The operator's complaint was not the sign-in, it was what came after: the window sat
// there with no way to know whether the login had taken or what to do next (11 Nov). So
// nothing here waits for them to close anything. It polls the page it is already standing
// on, and when the page stops asking to be signed into — no password box, no sign-in
// route, twice in a row, loaded — the window is closed and the caller is told.
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
  return !looksUnconfirmed(state.url, state.passwords);
}

/**
 * Poll until the session looks real, the window goes, or the clock runs out.
 *
 * `onSignedIn(url)` is called once, after the window has been closed by `browser.stop()`;
 * `onGone(why)` is called when the window disappears first (the operator closed it) or the
 * wait ran out — never as a success, because nothing proved a session.
 */
export function watchForSignIn(browser, { intervalMs = 2000, timeoutMs = 10 * 60 * 1000, onSignedIn = null, onGone = null, log = null } = {}) {
  let stopped = false;
  let streak = 0;

  const finish = (why) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearTimeout(deadline);
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
    if (signedInNow(state)) {
      streak += 1;
      if (streak < 2) return;
      stopped = true;
      clearInterval(timer);
      clearTimeout(deadline);
      log?.info?.(`browser: signed in at ${state.url} — closing the window for the operator`);
      try { await browser.stop(); } catch { /* it may already be gone */ }
      try { onSignedIn?.(state.url); } catch { /* a listener must not break the page */ }
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
