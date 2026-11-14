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
import { hostOf, hostAllowed, checkUrl, localPageAllowed } from '../src/browser/allow.js';
import { createBrowser, findEdge, siteDomains, cookieBelongsTo, keyForChar } from '../src/browser/browser.js';
import { addressCandidates, looksUnconfirmed } from '../src/browser/signin.js';
import { tmpdir } from './tmpdir.mjs';

// ── the window ──────────────────────────────────────────────────
// The browser is headed but hidden: a tool window, off-screen, still rendering. Two ways
// it could leave a taskbar entry the operator sees and cannot open (13 Nov): only the
// first window found was converted, so a second Edge window kept its button; and the hide
// path flashed that button, which is attention drawn to a window nobody should see.
test('the hide path covers every window and never flashes a taskbar button', () => {
  const script = fs.readFileSync(new URL('../src/browser/show.ps1', import.meta.url), 'utf8');
  const hideAt = script.indexOf('if ($Hide) {');
  const elseAt = script.indexOf('} else {', hideAt);
  assert.ok(hideAt > 0 && elseAt > hideAt, 'the hide branch is still there');
  const hideBranch = script.slice(hideAt, elseAt);
  assert.match(hideBranch, /foreach \(\$win in \$found\)/, 'every window of the profile is hidden');
  assert.doesNotMatch(hideBranch, /FlashWindowEx/, 'hiding does not flash a taskbar button');
  assert.match(script.slice(elseAt), /FlashWindowEx/, 'showing still flashes it, so a sign-in is noticed');
});

// A window can appear after the one pass — a cold start, a "Restore pages" bubble, a
// popup — and each one that missed the pass sat on the taskbar until the browser closed
// (14 Nov). An untitled window was skipped by the finder, which is exactly what a fresh
// about:blank window looks like for a moment.
test('a window that appears after the first pass is still hidden', () => {
  const script = fs.readFileSync(new URL('../src/browser/show.ps1', import.meta.url), 'utf8');
  assert.match(script, /\[int\]\$WatchMs = 0/, 'the script takes a watch window');
  assert.match(script, /if \(\$WatchMs -gt 0\)/, 'and watches while it is asked to');
  assert.match(script, /synapse-shown/, 'a sign-in window is left alone by the watcher');
  assert.doesNotMatch(script, /if \(-not \$title\.ToString\(\)\)/, 'an untitled window is still ours');
  const js = fs.readFileSync(new URL('../src/browser/browser.js', import.meta.url), 'utf8');
  assert.match(js, /watchBrowserWindow\(\{ profile \}\)/, 'the browser starts the watcher');
});

// The operator's question (14 Nov): what else could these rules touch? Only Edge processes
// launched with `--user-data-dir=<SynaBrowse's own profile>` — the whole argument, not
// "the command line mentions the folder". Edge a person or Windows opens runs on its own
// profile, and a process that merely names our path elsewhere is left alone.
test('only Synapse’s own Edge profile is ever touched', () => {
  const script = fs.readFileSync(new URL('../src/browser/show.ps1', import.meta.url), 'utf8');
  assert.match(script, /function Get-OurEdgePids/, 'one rule, used by the pass and the watcher');
  assert.ok((script.match(/Get-OurEdgePids/g) || []).length >= 3, 'both callers use it');
  assert.match(script, /--user-data-dir="\?/, 'the match is the whole argument');
  assert.doesNotMatch(script, /\.Contains\(\$markerKey\)/, 'not a mention anywhere in the command line');
  assert.match(script, /\[regex\]::Escape\(\$markerKey\)/, 'the folder is matched literally');
});

// A character is pressed as the key it sits on, so a page's own keydown sees "7" — which
// is what a calculator or a shortcut listens for; `type` cannot do that (14 Nov).
test('a printable character maps to the key a person would press', () => {
  assert.deepEqual(keyForChar('7'), { code: 'Digit7', key: '7', vk: 55 });
  assert.deepEqual(keyForChar('='), { code: 'Equal', key: '=', vk: 187 });
  assert.deepEqual(keyForChar('+'), { code: 'Equal', key: '+', vk: 187 });
  assert.equal(keyForChar('a').code, 'KeyA');
  assert.equal(keyForChar('A').key, 'A');
  assert.equal(keyForChar(' ').code, 'Space');
  assert.equal(keyForChar('é'), null, 'a character that is not on this keyboard is not a key');
  assert.equal(keyForChar('ab'), null, 'one character at a time');
  assert.equal(keyForChar(''), null);
});

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

// A model that writes a mock needs to look at it: on 14 Nov one was refused its own
// `file:///F:/dev/Synapse.Projects/test/mock-2.html` and guessed instead. The fence is
// the projects folder and the page extension — never the harness, never the machine.
test('a local page is allowed only inside the projects folder, and only as HTML', () => {
  const root = 'F:\\dev\\Synapse.Projects';
  const ok = (url) => localPageAllowed(url, { root }).ok;
  assert.equal(ok('file:///F:/dev/Synapse.Projects/test/mock-2.html'), true, 'a mock the model wrote');
  assert.equal(ok('file:///F:/dev/Synapse.Projects/test/MOCK.HTM'), true, 'the extension is not case-sensitive');
  assert.equal(ok('file:///F:/dev/Synapse.Projects/test/mock-2.txt'), false, 'only a page');
  assert.equal(ok('file:///F:/dev/Synapse/AGENTS.md'), false, 'the harness is not a page');
  assert.equal(ok('file:///F:/dev/Synapse.Projects/../Synapse/src/index.js'), false, 'no climbing out');
  assert.equal(ok('file:///C:/Windows/win.ini'), false, 'nor the machine');
  assert.equal(ok('https://example.com'), false, 'this is the local-file rule, not the web one');
  assert.equal(ok('nonsense'), false, 'and it is a URL or it is nothing');
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
      <script>window.typed = ''; addEventListener('keydown', (e) => { window.typed += e.key; });</script>
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

    // A page with a keyboard handler needs real key events, not inserted text: "7", "="
    // and "+" press as the keys they are, and the page's own keydown sees them (14 Nov).
    await browser.press('7');
    await browser.press('=');
    await browser.press('+');
    await browser.press('Enter');
    const keys = await browser.start().then((p) => p.evaluate('window.typed'));
    assert.equal(keys, '7=+Enter', `the page saw ${JSON.stringify(keys)}`);
    // A chord is refused, not typed one character at a time; a key that is not on the
    // keyboard at all says so.
    await assert.rejects(() => browser.press('ctrl+c'), /Chords are not supported/, 'a chord is named, not typed');
    await assert.rejects(() => browser.press('\u0001'), /unknown key/, 'a control character is not a key');

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
      <div class="by"><a href="/user/alice">u/alice</a> <time>2h</time></div>
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
    assert.match(page.text, /u\/alice/, 'a byline standing outside the paragraphs is a label, and stays');
    assert.doesNotMatch(page.text, /Careers|Privacy|Terms/, 'the nav and footer should not be in the article');
    assert.equal(page.wall, '');

    // Text mode is the whole page in its own lines. It used to be squeezed to one line,
    // so a thread arrived as a single paragraph with the names buried in it (14 Nov).
    const whole = await browser.read({ mode: 'text', maxChars: 100000 });
    assert.match(whole.text, /u\/alice/, 'text mode keeps the author');
    assert.ok(whole.text.split('\n').length >= 5, `text mode keeps the page's lines (${whole.text.split('\n').length})`);
    assert.match(whole.text, /First paragraph of the article[\s\S]*Second paragraph/, 'and the blocks stay apart');

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
