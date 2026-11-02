// Reading a page as text, and refusing the ones that are walled.
//
// The network is not in these tests: `webFetch` takes the fetch it should use, so
// every case here is a fixture and the suite stays offline and fast. The wall cases
// are copied from what the real sites actually answered on 2 Nov (Cloudflare's
// "Just a moment...", Reddit's "Prove your humanity", x.com's 403), which is why the
// messages can name them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch, htmlToText, extractReadable, FetchError, formatPage } from '../src/fetch.js';

/** A fetch that answers from a routing table: [match, reply] pairs. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push(String(url));
    for (const [match, reply] of routes) {
      if (String(url).includes(match)) {
        const r = typeof reply === 'function' ? await reply(url, opts) : reply;
        const body = r.body ?? '';
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status: r.status ?? 200,
          headers: { 'content-type': r.type ?? 'text/html; charset=utf-8', ...(r.headers || {}) },
        });
      }
    }
    throw new Error(`no fixture for ${url}`);
  };
  fn.calls = calls;
  return fn;
}

test('a page keeps its prose and loses its chrome', () => {
  const html = `<!doctype html><html><head><title>The Article</title></head><body>
    <nav><a href="/home">Home</a><a href="/about">About</a></nav>
    <script>var tracking = 'do not read me';</script>
    <article>
      <h1>Readable Things</h1>
      <p>First paragraph with a <a href="/relative">relative link</a>.</p>
      <ul><li>one item</li><li>two items</li></ul>
      <pre>code block</pre>
    </article>
    <footer>© 2026 Nobody</footer>
    </body></html>`;
  const { title, text } = extractReadable(html, 'https://example.com/page');
  assert.equal(title, 'The Article');
  assert.match(text, /Readable Things/);
  assert.match(text, /First paragraph/);
  assert.doesNotMatch(text, /do not read me/, 'scripts are not content');
  assert.doesNotMatch(text, /Home|About/, 'navigation is not content');
  assert.doesNotMatch(text, /Nobody/, 'the footer is not content');
  assert.match(text, /\[relative link\]\(https:\/\/example\.com\/relative\)/, 'links are absolute and keep their words');
  assert.match(text, /- one item/, 'lists stay lists');
});

test('github repositories are read through the API, not the HTML', async () => {
  const fetchImpl = fakeFetch([
    ['/readme', { body: '# Synapse\n\nA harness.', type: 'text/plain' }],
    ['api.github.com/repos/owner/repo', { body: { full_name: 'owner/repo', description: 'Does things', language: 'JavaScript', stargazers_count: 12, forks_count: 3, open_issues_count: 1, license: { spdx_id: 'MIT' }, topics: ['agents'], default_branch: 'main' }, type: 'application/json' }],
  ]);
  const page = await webFetch('https://github.com/owner/repo', { fetchImpl });
  assert.equal(page.source, 'github:repo');
  assert.match(page.text, /# owner\/repo/);
  assert.match(page.text, /stars: 12/);
  assert.match(page.text, /topics: agents/);
  assert.match(page.text, /# Synapse/, 'the README is included');
  assert.ok(fetchImpl.calls.every((u) => !u.includes('github.com/owner/repo') || u.includes('api.github.com')), 'never fetched the HTML page');
});

test('a github issue comes back as the issue, body and all', async () => {
  const fetchImpl = fakeFetch([
    ['api.github.com/repos/owner/repo/issues/7', { body: { title: 'Crash on start', number: 7, state: 'open', user: { login: 'operator' }, comments: 2, labels: [{ name: 'bug' }], body: 'It crashes.' }, type: 'application/json' }],
  ]);
  const page = await webFetch('https://github.com/owner/repo/issues/7', { fetchImpl });
  assert.equal(page.source, 'github:issue');
  assert.match(page.text, /Crash on start/);
  assert.match(page.text, /Labels: bug/);
  assert.match(page.text, /It crashes\./);
});

test('an X post is read through oEmbed', async () => {
  const fetchImpl = fakeFetch([
    ['publish.twitter.com/oembed', { body: { author_name: 'Someone', author_url: 'https://x.com/someone', html: '<blockquote><p>A short post about things.</p></blockquote>' }, type: 'application/json' }],
  ]);
  const page = await webFetch('https://x.com/someone/status/123456', { fetchImpl });
  assert.equal(page.source, 'x:oembed');
  assert.match(page.text, /A short post about things/);
  assert.match(page.title, /Someone/);
});

test('a bot challenge is refused with the reason a model can act on', async () => {
  const fetchImpl = fakeFetch([
    ['4pda.to', { status: 403, body: '<html><title>Just a moment...</title><body><div id="challenge-platform"></div></body></html>' }],
  ]);
  await assert.rejects(
    () => webFetch('https://4pda.to/forum/index.php?showtopic=1', { fetchImpl }),
    (err) => {
      assert.ok(err instanceof FetchError);
      assert.equal(err.blocked, true);
      assert.match(err.message, /bot check \(Cloudflare\)/);
      assert.match(err.message, /signed-in browser session/);
      return true;
    },
  );
});

test('a page that renders to nothing names the host that walls it', async () => {
  const fetchImpl = fakeFetch([
    ['reddit.com', { body: '<html><body><div id="root"></div></body></html>' }],
  ]);
  await assert.rejects(
    () => webFetch('https://www.reddit.com/r/x/comments/1/', { fetchImpl }),
    (err) => {
      assert.equal(err.blocked, true);
      assert.match(err.message, /Reddit/);
      assert.match(err.message, /renders to nothing/);
      return true;
    },
  );
});

test('a dropped connection is retried once, and an answer is not', async () => {
  let attempts = 0;
  const flaky = async (url) => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return new Response('<article><p>' + 'text '.repeat(40) + '</p></article>', { headers: { 'content-type': 'text/html' } });
  };
  const page = await webFetch('https://example.com/flaky', { fetchImpl: flaky });
  assert.equal(attempts, 2, 'the network was tried twice');
  assert.match(page.text, /text text/);

  let answered = 0;
  const refused = async () => {
    answered += 1;
    return new Response('nope', { status: 404 });
  };
  await assert.rejects(() => webFetch('https://example.com/missing', { fetchImpl: refused }));
  assert.equal(answered, 1, 'a 404 is an answer: retrying it is rudeness');
});

test('long pages are truncated with a note, short ones are not', async () => {
  const body = `<article><p>${'word '.repeat(3000)}</p></article>`;
  const fetchImpl = fakeFetch([['example.com', { body }]]);
  const page = await webFetch('https://example.com/long', { fetchImpl, maxChars: 2000 });
  assert.equal(page.truncated, true);
  assert.match(page.text, /truncated at 2000 characters/);
  assert.ok(page.text.length < 2200);
  const head = formatPage(page);
  assert.match(head, /\(readability, \d+ characters, truncated\)/);
});

test('htmlToText handles the pieces a page is made of', () => {
  const text = htmlToText('<h2>Title</h2><p>Some <strong>bold</strong> and <code>code()</code>.</p><blockquote>Quoted.</blockquote>', 'https://e.com/');
  assert.match(text, /## Title/);
  assert.match(text, /\*\*bold\*\*/);
  assert.match(text, /`code\(\)`/);
  assert.match(text, /> Quoted\./);
});
