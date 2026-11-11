// The one thing only a person can do: sign in.
//
// Opens SynaBrowse on whatever the operator typed — `reddit.com`, `мос.ру`, a LAN address
// like `192.168.1.5:8080` — and puts it on the second monitor so they can log in. The
// address is *not* validated against a format: a browser resolves what a person types,
// and a harness that insists on `https://` is refusing addresses the browser accepts.
// The only judgement made here is which scheme to try first.
//
// The session it creates lives in the browser's own profile, so every project inherits
// it and nothing has to be copied.
import path from 'node:path';
import { createBrowser, findEdge } from './browser.js';
import { askOperator } from './handoff.js';
import { hostOf } from './allow.js';
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

/**
 * Show the browser on a site and ask the operator to sign in.
 *
 * `restore` shows the window (on the second monitor) instead of leaving it minimized:
 * a fresh sign-in needs a page on screen, and it is the operator's choice to swing it up.
 * `sound` is the chime path, or '' for silence (the Settings switch).
 * `onDone` is called once when that window closes — the operator's own "I am finished" —
 * so the caller can record the site and say the session is kept.
 */
export async function askToSignIn({ url, profile, log = null, restore = true, sound = null, onDone = null } = {}) {
  if (!findEdge()) return { ok: false, error: 'no Edge on this machine' };
  const candidates = addressCandidates(url);
  if (!candidates.length) return { ok: false, error: 'there is no address to open' };

  const browser = createBrowser({ profile, log });
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
    return { ok: false, url: candidates[0], error: failure || 'the address did not open' };
  }

  const asked = await askOperator({
    profile: browser.profile,
    restore,
    // '' silences it; null keeps the script's own default.
    ...(sound === null ? {} : { sound }),
  });

  // The operator closes the window when they are done; that is the only signal a harness
  // can honestly take for "finished", and it is the one the toast is built on.
  if (onDone) {
    const began = Date.now();
    const timer = setInterval(async () => {
      const still = await browser.alive().catch(() => false);
      if (still && Date.now() - began < 20 * 60 * 1000) return;
      clearInterval(timer);
      if (!still) {
        try { onDone(opened); } catch { /* a listener must not break the page */ }
      }
    }, 2000);
    timer.unref?.();
  }

  return {
    ok: Boolean(asked.ok),
    url: opened,
    host: hostOf(opened),
    window: asked.window || null,
    error: asked.ok ? null : asked.error || 'the window did not come up',
  };
}
