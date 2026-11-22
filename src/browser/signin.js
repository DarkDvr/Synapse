// The one thing only a person can do: sign in.
//
// Opens SynaBrowse on whatever the operator typed — a bare host, a name in another script, a LAN address
// like `192.168.1.5:8080` — and puts it on their monitor so they can log in. The
// address is *not* validated against a format: a browser resolves what a person types,
// and a harness that insists on `https://` is refusing addresses the browser accepts.
// The only judgement made here is which scheme to try first.
//
// This is a **visible** window by definition, never the hidden desktop: a window there
// cannot be moved to the operator's monitor. A caller that already owns the visible
// instance passes it in (`browser`), which is how the model hand-off keeps the handle it
// needs to stop before the hidden browser takes the profile back.
import path from 'node:path';
import { createBrowser, findEdge } from './browser.js';
import { askOperator } from './handoff.js';
import { hostOf } from './allow.js';
import { watchForSignIn } from './session-watch.js';
import { WEB_DIR } from '../paths.js';

/**
 * The forms of an address worth trying, in order.
 *
 * A typed address has no scheme more often than not, and the two guesses that matter are
 * https (the internet) and http (a box on the LAN). Anything with a scheme is taken at its
 * word: `http://`, `file://`, or something this code has never heard of.
 */
export function addressCandidates(input) {
  const raw = String(input || '').trim().replace(/^["'<]+|["'>]+$/g, '');
  if (!raw) return [];
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return [raw];
  return [`https://${raw}`, `http://${raw}`];
}

/** A URL that still means "you are not signed in". */
const LOGIN_ROUTE = /\/(?:log-?in|sign-?in|signin|auth|sso|session\/new)(?:[/?#]|$)/i;

/**
 * Does a page still ask to be signed into?
 *
 * Two signals, both visible on the page and neither a guess about the site: the address
 * is a sign-in route, or a password box is on it. A page that passes both is taken as
 * signed in — which is what the operator saw when they closed the window.
 */
export function looksUnconfirmed(url, passwordInputs = 0) {
  return LOGIN_ROUTE.test(String(url || '')) || Number(passwordInputs) > 0;
}

/**
 * Show the browser on a site and ask the operator to sign in.
 *
 * `restore` shows the window (on the second monitor) instead of leaving it minimized:
 * a fresh sign-in needs a page on screen, and it is the operator's choice to swing it up.
 * `sound` is the chime path, or '' for silence (the Settings switch).
 * `onSignedIn` is called once the page stops asking for a sign-in; with `autoHide` the
 * window has already been hidden by then, and with `autoHide: false` it is left for the
 * operator to close (the model hand-off, where a bot check is not a password box).
 * `browser` lets a caller that already owns a visible instance keep the handle, so it can
 * stop it before the hidden desktop takes the profile back.
 */
export async function askToSignIn({
  url,
  profile,
  log = null,
  browser: provided = null,
  restore = true,
  focus = false,
  sound = null,
  autoHide = true,
  onSignedIn = null,
  onGone = null,
} = {}) {
  if (!provided && !findEdge()) return { ok: false, error: 'no Edge on this machine' };
  const candidates = addressCandidates(url);
  if (!candidates.length) return { ok: false, error: 'there is no address to open' };

  // A sign-in window is visible by definition. It must never be created on the hidden
  // desktop: a window there cannot be moved to the monitor the operator is looking at.
  const browser = provided || createBrowser({ profile, log, hiddenDesktop: false });
  if (!provided) {
    // Start before navigating, so a running hidden browser is recognised rather than
    // silently navigated away from the model's work.
    try {
      await browser.start();
    } catch (err) {
      try { await browser.stop(); } catch { /* not started */ }
      return { ok: false, url: candidates[0], error: err.message };
    }
    if (browser.isAttached?.()) {
      return {
        ok: false,
        error: 'SynaBrowse is already open for a run; use the sign-in card in that chat, or close the run first.',
      };
    }
  }
  let opened = null;
  let failure = null;
  for (const candidate of candidates) {
    try {
      opened = await browser.goto(candidate, { settle: 900 });
      break;
    } catch (err) {
      failure = err.message;
    }
  }
  if (!opened) {
    if (!provided) { try { await browser.stop(); } catch { /* not started */ } }
    return { ok: false, url: candidates[0], error: failure || 'the address did not open' };
  }

  // The WebView2 host is already a visible window the caller owns. show.ps1 finds Edge
  // windows by profile, and returns "no SynaBrowse window" for the host — which used to
  // close it before the operator could sign in (22 Nov). Only Edge needs placing.
  const hostWindow = provided?.hostMode === true;
  const asked = hostWindow
    ? { ok: true, window: { state: 'shown', screen: 'operator', toolWindow: false, onScreen: true }, error: null }
    : await askOperator({
      profile: browser.profile,
      restore,
      focus,
      // '' silences it; null keeps the script's own default.
      ...(sound === null ? {} : { sound }),
    });
  if (hostWindow) log?.info?.('browser: sign-in window is the visible WebView2 host');
  if (asked.window) {
    // The next live hand-off has one line to read: which monitor it landed on, whether
    // it is still a tool window, and whether it is inside that monitor's work area.
    log?.info?.(
      `browser: sign-in window ${asked.window.state || 'unknown'} on ${asked.window.screen || '?'} ` +
        `(toolWindow=${Boolean(asked.window.toolWindow)}, onScreen=${Boolean(asked.window.onScreen)})`,
    );
  }

  // Nobody has to close anything: the page is watched, and the moment it stops asking
  // to be signed into, the window is taken away and the caller is told (11 Nov).
  watchForSignIn(browser, {
    log,
    autoHide,
    onSignedIn: (finalUrl) => { try { onSignedIn?.(finalUrl); } catch { /* a listener must not break the page */ } },
    onGone: (why) => { try { onGone?.(why); } catch { /* a listener must not break the page */ } },
  });

  return {
    ok: Boolean(asked.ok),
    url: opened,
    host: hostOf(opened),
    window: asked.window || null,
    error: asked.ok ? null : asked.error || 'the window did not come up',
    browser,
  };
}
