// The one thing only a person can do: sign in.
//
// Opens SynaBrowse on a URL, puts it on the second monitor's taskbar minimized (no focus,
// one chime), and answers whether the window came up. The session it creates lives in the
// browser's own profile, so every project inherits it and nothing has to be copied.
//
// Used by Settings → Browser → Sign In…, and by the `handoff` tool when a page needs a
// check the harness cannot pass.
import path from 'node:path';
import { createBrowser, findEdge } from './browser.js';
import { askOperator } from './handoff.js';
import { WEB_DIR } from '../paths.js';

/**
 * Show the browser on a site and ask the operator to sign in.
 *
 * `restore` shows the window (on the second monitor) instead of leaving it minimized:
 * a fresh sign-in needs a page on screen, and it is the operator's choice to swing it up.
 */
export async function askToSignIn({ url, profile, log = null, restore = true } = {}) {
  if (!findEdge()) return { ok: false, error: 'no Edge on this machine' };
  const browser = createBrowser({ profile, log });
  try {
    await browser.goto(url, { settle: 900 });
    const asked = await askOperator({
      profile: browser.profile,
      restore,
      sound: path.join(WEB_DIR, 'sounds', 'chime.wav'),
    });
    return {
      ok: Boolean(asked.ok),
      url,
      window: asked.window || null,
      error: asked.ok ? null : asked.error || 'the window did not come up',
    };
  } catch (err) {
    return { ok: false, url, error: err.message };
  }
}
