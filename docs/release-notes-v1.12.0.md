# Synapse v1.12.0

The manual cookie editor is gone, and the reason it was the wrong shape is now written
down with the evidence.

## Removed

- **Settings → General → Sites That Need a Sign-In**, with its textarea, its Save button
  and its `/api/site-sessions` endpoints. The operator's verdict was right: copying a
  Cookie header out of DevTools and formatting it is work for them and value for
  nobody, and it expires.

## Kept

- The storage and the sending rules (`src/site-sessions.js`): a cookie is stored in
  `data\` (gitignored, never logged), sent only to the host it belongs to or its
  subdomains, and redirects are followed by hand so it cannot travel elsewhere. Whatever
  fills that file must still obey them, and the tests that pin them still run.

## What the better idea costs

The operator suggested the sane design: when the AI needs a session, ask, close the
browser, take the cookie. It does not work, and that was measured rather than assumed:

- Chromium refuses remote debugging on the default profile — *"DevTools remote debugging
  requires a non-default data directory."*
- Reaching the same profile through a directory junction **opens the debugger, reads
  zero cookies, and empties the profile's cookie store** on the way in. On this machine
  Edge went from 87 cookie rows to 0, with no WAL to recover from. That is a real cost
  of the experiment, and it is recorded in `docs/notes/todo.md` as a warning.
- The only remaining route is a WebView2 sign-in window inside Synapse — about a day of
  shell work, still deferred.

Until then `webfetch` refuses walled pages honestly and says why, which is the behaviour
that lets a model tell the operator instead of inventing an answer.

Full suite: 355 tests.
