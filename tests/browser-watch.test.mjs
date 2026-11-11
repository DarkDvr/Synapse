// Watching for a sign-in, and taking the window away when it lands.
//
// Nothing waits for the operator to close anything: the page is polled, and the moment it
// stops asking to be signed into, the window goes (11 Nov). These tests use a fake browser
// with a scripted sequence of page states, so the timing rule is proved without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signedInNow, watchForSignIn } from '../src/browser/session-watch.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A browser whose page state follows a script, and which records what it was asked. */
function fakeBrowser(states) {
  let i = 0;
  const calls = { stopped: 0, hidden: 0 };
  return {
    calls,
    async pageState() {
      const next = states[Math.min(i, states.length - 1)];
      i += 1;
      if (next === 'gone') throw new Error('the window is gone');
      return next;
    },
    async stop() { calls.stopped += 1; },
    async hideWindow() { calls.hidden += 1; return true; },
  };
}

const LOGIN = { url: 'https://example.test/login', passwords: 1, ready: 'complete' };
const SIGNED = { url: 'https://example.test/home', passwords: 0, ready: 'complete' };

test('a page is signed in when it asks for no password and is not on a sign-in route', () => {
  assert.equal(signedInNow(SIGNED), true);
  assert.equal(signedInNow(LOGIN), false);
  assert.equal(signedInNow({ url: 'https://example.test/account', passwords: 0, ready: 'loading' }), false, 'a page still loading is not proof');
  assert.equal(signedInNow(null), false);
});

test('the window is closed once the sign-in lands, and the caller is told once', async () => {
  const browser = fakeBrowser([LOGIN, LOGIN, SIGNED, SIGNED, SIGNED]);
  let signedIn = 0;
  let gone = 0;
  watchForSignIn(browser, {
    intervalMs: 5,
    timeoutMs: 500,
    onSignedIn: () => { signedIn += 1; },
    onGone: () => { gone += 1; },
  });
  await wait(120);
  assert.equal(signedIn, 1, 'exactly one sign-in');
  assert.equal(gone, 0, 'a sign-in is not a disappearance');
  assert.equal(browser.calls.hidden, 1, 'the window is taken away without closing the browser');
  assert.equal(browser.calls.stopped, 0, 'the page must survive: closing it left the model reading about:blank');
});

test('a two-step sign-in is not cut short between its steps', async () => {
  // Password box disappears, then comes back for the second step.
  const twoStep = { url: 'https://example.test/step2', passwords: 0, ready: 'complete' };
  const browser = fakeBrowser([LOGIN, twoStep, LOGIN, twoStep, SIGNED, SIGNED]);
  let signedIn = 0;
  watchForSignIn(browser, { intervalMs: 5, timeoutMs: 500, onSignedIn: () => { signedIn += 1; } });
  await wait(120);
  assert.equal(signedIn, 1);
});

test('a window that goes away is an ending, not a sign-in', async () => {
  const browser = fakeBrowser([LOGIN, 'gone']);
  let signedIn = 0;
  let why = null;
  watchForSignIn(browser, { intervalMs: 5, timeoutMs: 500, onSignedIn: () => { signedIn += 1; }, onGone: (reason) => { why = reason; } });
  await wait(100);
  assert.equal(signedIn, 0);
  assert.equal(why, 'closed');
  assert.equal(browser.calls.hidden, 0, 'nothing to hide');
});

test('a wait that runs out ends quietly', async () => {
  const browser = fakeBrowser([LOGIN]);
  let why = null;
  watchForSignIn(browser, { intervalMs: 5, timeoutMs: 40, onGone: (reason) => { why = reason; } });
  await wait(120);
  assert.equal(why, 'timeout');
});
