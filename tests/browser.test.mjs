// SynaBrowse, offline: the allowlist as a rule, and the browser as a tool.
//
// The allowlist half is pure and always runs. The browser half starts a real Edge with a
// throwaway profile and drives a local page — no network — so the tools are proved the
// way the suite proves everything else: by asking the thing itself, not the source.
//
// It skips cleanly on a machine without Edge (and says why), because a missing browser is
// not a broken harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hostOf, hostAllowed, checkUrl } from '../src/browser/allow.js';
import { createBrowser, findEdge, siteDomains, cookieBelongsTo } from '../src/browser/browser.js';
import { addressCandidates, looksUnconfirmed } from '../src/browser/signin.js';
import { tmpdir } from './tmpdir.mjs';

// ── the fence ───────────────────────────────────────────────────
test('a listed host covers itself and its subdomains, and nothing that looks like it', () => {
  assert.equal(hostAllowed('example.com', ['example.com']), true);
  assert.equal(hostAllowed('www.example.com', ['example.com']), true);
  assert.equal(hostAllowed('example.com.evil.test', ['example.com']), false);
  assert.equal(hostAllowed('notexample.com', ['example.com']), false);
  assert.equal(hostAllowed('example.com', ['*']), true);
  assert.equal(hostAllowed('example.com', []), false);
  assert.equal(hostAllowed('example.com', ['www.example.com']), false, 'a subdomain does not cover its parent');
});

test('a refused URL says why, and where to fix it', () => {
  const blocked = checkUrl('https://example.com/some/page', ['allowed.test']);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.host, 'example.com');
  assert.match(blocked.reason, /not on SynaBrowse's allowlist/);
  assert.match(blocked.reason, /Settings > Browser/);

  const odd = checkUrl('file:///F:/dev/Synapse/AGENTS.md', ['*']);
  assert.equal(odd.ok, false, 'only http(s) is a page');
});

test('a URL parses to its host and keeps no lookalike', () => {
  assert.equal(hostOf('https://WWW.Example.COM./x'), 'www.example.com');
  assert.equal(hostOf('not a url'), '');
  assert.equal(hostOf('javascript:alert(1)'), '');
});

// The sign-in field takes what a person types. A browser resolves it; the harness only
// decides which scheme to try first, because a typed address usually has none, and a
// local box usually speaks http.
test('an address with no scheme is tried as https, then http', () => {
  assert.deepEqual(addressCandidates('reddit.com'), ['https://reddit.com', 'http://reddit.com']);
  assert.deepEqual(addressCandidates('мос.ру'), ['https://мос.ру', 'http://мос.ру']);
  assert.deepEqual(addressCandidates('192.168.1.20:8080'), ['https://192.168.1.20:8080', 'http://192.168.1.20:8080']);
});

test('an address that states its scheme is taken at its word', () => {
  assert.deepEqual(addressCandidates('http://192.168.1.5:9000/x'), ['http://192.168.1.5:9000/x']);
  assert.deepEqual(addressCandidates('  "https://example.com/" '), ['https://example.com/']);
  assert.deepEqual(addressCandidates('file:///F:/dev/Synapse/AGENTS.md'), ['file:///F:/dev/Synapse/AGENTS.md']);
  assert.deepEqual(addressCandidates(''), []);
});

// ── the browser ─────────────────────────────────────────────────
const PAGE = (body) => `<!doctype html><meta charset="utf-8"><title>SynaBrowse test</title>
<body style="font:16px system-ui;background:#0d1117;color:#eee">${body}</body>`;

test('the tools drive a local page: read, click, type, screenshot, watch', async (t) => {
  const edge = findEdge();
  if (!edge) {
    t.skip('no Edge on this machine');
    return;
  }
  const dir = tmpdir('synabrowse-');
  const profile = path.join(dir, 'profile');
  const page = path.join(dir, 'page.html');
  fs.writeFileSync(
    page,
    PAGE(`
      <h1 id="head">first</h1>
      <button id="go" onclick="document.getElementById('head').textContent='clicked'">Go</button>
      <input id="field" placeholder="type here" />
      <div id="out">nothing yet</div>
      <div style="width:60px;height:60px;background:#ff7d1a;animation:spin 1s linear infinite"></div>
    `).replace('</body>', '<style>@keyframes spin{to{transform:rotate(360deg)}}</style></body>'),
  );

  const browser = createBrowser({ profile, startMinimized: true });
  try {
    await browser.goto(`file:///${page.replace(/\\/g, '/')}`);
    const read = await browser.read({});
    assert.equal(read.title, 'SynaBrowse test');
    assert.match(read.text, /first/);

    await browser.click({ selector: '#go' });
    assert.match((await browser.read({})).text, /clicked/, 'the click did not run the page');

    await browser.type({ text: 'hello', selector: '#field' });
    const typed = await browser.start().then((p) => p.evaluate("document.getElementById('field').value"));
    assert.equal(typed, 'hello');

    const png = await browser.screenshot({ full: false });
    assert.ok(png.length > 1000, 'a screenshot is a picture');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');

    const frames = await browser.watch({ ms: 500, dir: path.join(dir, 'frames') });
    assert.ok(frames.length >= 1, 'a screencast produced no frames');
    assert.ok(fs.existsSync(frames[0].file));
  } finally {
    await browser.stop();
    // Edge lets go of its profile a moment after the process exits; the folder is a
    // tmpdir() and would be swept anyway, so a locked file is not a test failure.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* swept at exit */ }
  }
});

// A session is "confirmed" only when the page comes up without asking to be signed into.
// Two signals, both visible: a sign-in route, or a password box. Anything else is a page.
test('a page that still asks for a sign-in is not confirmed', () => {
  assert.equal(looksUnconfirmed('https://example.com/login'), true);
  assert.equal(looksUnconfirmed('https://example.com/sign-in?next=/x'), true);
  assert.equal(looksUnconfirmed('https://example.com/auth/sso'), true);
  assert.equal(looksUnconfirmed('https://example.com/', 1), true);
  assert.equal(looksUnconfirmed('https://example.com/', 0), false);
  assert.equal(looksUnconfirmed('https://example.com/account/logins'), false, 'a path that merely starts with "login" is not a login page');
});

// The page a model reads is the article, not the furniture: a nav and a footer are the
// two things every site has and no model needs, and they cost the same tokens as prose.
test('read() returns the article and says when a page is a sign-in wall', async (t) => {
  const edge = findEdge();
  if (!edge) {
    t.skip('no Edge on this machine');
    return;
  }
  const dir = tmpdir('synabrowse-read-');
  const profile = path.join(dir, 'profile');
  const article = path.join(dir, 'article.html');
  const login = path.join(dir, 'login.html');
  fs.writeFileSync(article, `<!doctype html><title>Article page</title>
    <nav><a href="/a">Products</a><a href="/b">Pricing</a><a href="/c">Careers</a></nav>
    <main><article><h1>The real story</h1>
      <p>First paragraph of the article, with the substance in it.</p>
      <h2>A heading</h2>
      <p>Second paragraph, also substance rather than chrome.</p>
      <ul><li>one point</li><li>another point</li></ul>
    </article></main>
    <footer><a href="/x">Privacy</a><a href="/y">Terms</a></footer>`);
  fs.writeFileSync(login, `<!doctype html><title>Sign in</title>
    <main><h1>Sign in to continue</h1>
    <form><input type="text" name="user" /><input type="password" name="pass" /><button>Sign in</button></form></main>`);

  const browser = createBrowser({ profile, startMinimized: true });
  try {
    await browser.goto(`file:///${article.replace(/\\/g, '/')}`);
    const page = await browser.read({});
    assert.match(page.text, /First paragraph of the article/);
    assert.match(page.text, /one point/);
    assert.doesNotMatch(page.text, /Careers|Privacy|Terms/, 'the nav and footer should not be in the article');
    assert.equal(page.wall, '');

    await browser.goto(`file:///${login.replace(/\\/g, '/')}`);
    const wall = await browser.read({});
    assert.equal(wall.wall, 'a password box');
  } finally {
    await browser.stop();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* swept at exit */ }
  }
});

// Forgetting a site has to reach the parent domain its session actually lives on.
// Measured 11 Nov: clearing the origin www.reddit.com left seven cookies on .reddit.com,
// and the operator stayed signed in after the row had been removed.
test('a site\'s cookies include the parent domain, and nothing else', () => {
  assert.deepEqual(siteDomains('www.reddit.com'), ['www.reddit.com', '.www.reddit.com', 'reddit.com', '.reddit.com']);
  assert.deepEqual(siteDomains('https://www.reddit.com/r/x'), ['www.reddit.com', '.www.reddit.com', 'reddit.com', '.reddit.com']);
  assert.equal(cookieBelongsTo('.reddit.com', 'www.reddit.com'), true);
  assert.equal(cookieBelongsTo('www.reddit.com', 'www.reddit.com'), true);
  assert.equal(cookieBelongsTo('.example.test', 'www.reddit.com'), false);
  assert.equal(cookieBelongsTo('notreddit.com', 'www.reddit.com'), false, 'a lookalike is not a subdomain');
  assert.deepEqual(siteDomains(''), []);
});
