// Site cookies: what may be stored, what may be sent, and to whom.
//
// The manual editor is gone — the operator will not paste cookie headers, and that is
// the right call: it was work for them and value for nobody. The storage and the
// sending rules stay, because the browser-session grab (ask the operator, close the
// browser, read its cookies) will write through the same file, and these are the
// rules that must hold whatever fills it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validHost, readSessions, writeSessions, cookieFor } from '../src/site-sessions.js';
import { webFetch, FetchError } from '../src/fetch.js';

test('a host is a host, not a URL and not a path', () => {
  assert.equal(validHost('4pda.to'), '4pda.to');
  assert.equal(validHost('WWW.Example.co.uk'), 'www.example.co.uk');
  assert.equal(validHost('http://4pda.to'), '', 'a URL is not a host');
  assert.equal(validHost('4pda.to/forum'), '', 'a path is not a host');
  assert.equal(validHost('localhost'), '', 'a single label is not a site we hold a cookie for');
  assert.equal(validHost('a b.com'), '');
  assert.equal(validHost(''), '');
});

test('a cookie goes to its host and its subdomains, never to a lookalike', () => {
  const sessions = { '4pda.to': { cookie: 'bb_session=1' } };
  assert.equal(cookieFor('4pda.to', sessions).cookie, 'bb_session=1');
  assert.equal(cookieFor('www.4pda.to', sessions).host, '4pda.to');
  assert.equal(cookieFor('not4pda.to', sessions), null, 'the dot is what makes it a subdomain');
  assert.equal(cookieFor('4pda.to.evil.test', sessions), null);
  assert.equal(cookieFor('other.to', sessions), null);
});

test('sessions round-trip through the file, and an invalid host is dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-sessions-'));
  try {
    const file = path.join(dir, 'site-sessions.json');
    writeSessions({ '4pda.to': { cookie: 'bb_session=secret' }, bad: { cookie: 'x' } }, file);
    const back = readSessions(file);
    assert.deepEqual(Object.keys(back), ['4pda.to'], 'an invalid host is not stored');
    assert.equal(back['4pda.to'].cookie, 'bb_session=secret');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── what the fetcher does with it ───────────────────────────────────────

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), cookie: opts.headers?.cookie || '' });
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

const PAGE = `<article><h1>Members only</h1><p>${'the thread, as a member sees it. '.repeat(20)}</p></article>`;

test('the saved cookie is sent to its own host', async () => {
  const fetchImpl = fakeFetch([['4pda.to', { body: PAGE }]]);
  const page = await webFetch('https://4pda.to/forum/index.php?showtopic=1', {
    fetchImpl,
    sessions: { '4pda.to': { cookie: 'bb_session=secret' } },
  });
  assert.equal(fetchImpl.calls[0].cookie, 'bb_session=secret');
  assert.equal(page.source, 'readability+session');
  assert.match(page.text, /Members only/);
});

test('a cookie is not sent to a different site, and a session that still fails says so', async () => {
  const other = fakeFetch([['example.com', { body: PAGE }]]);
  await webFetch('https://example.com/page', { fetchImpl: other, sessions: { '4pda.to': { cookie: 'bb_session=secret' } } });
  assert.equal(other.calls[0].cookie, '', 'no cookie for a site it was not saved for');

  const stillWalled = fakeFetch([['4pda.to', { status: 403, body: '<title>Just a moment...</title><div id="challenge-platform"></div>' }]]);
  await assert.rejects(
    () => webFetch('https://4pda.to/x', { fetchImpl: stillWalled, sessions: { '4pda.to': { cookie: 'expired=1' } } }),
    (err) => {
      assert.ok(err instanceof FetchError);
      assert.match(err.message, /Your saved session for 4pda\.to was sent and the site still refused it/);
      return true;
    },
  );
});

test('a redirect to another host does not carry the cookie', async () => {
  const fetchImpl = fakeFetch([
    ['4pda.to/', { status: 302, body: '', headers: { location: 'https://evil.test/steal' } }],
    ['evil.test', { body: PAGE }],
  ]);
  await assert.rejects(
    () => webFetch('https://4pda.to/page', { fetchImpl, sessions: { '4pda.to': { cookie: 'bb_session=secret' } } }),
    (err) => {
      assert.match(err.message, /redirected to evil\.test/);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.some((c) => c.url.includes('evil.test')), false, 'the other site was never contacted');
});

test('a same-host redirect is followed with the cookie', async () => {
  const fetchImpl = fakeFetch([
    ['4pda.to/old', { status: 301, body: '', headers: { location: '/new' } }],
    ['4pda.to/new', { body: PAGE }],
  ]);
  const page = await webFetch('https://4pda.to/old', {
    fetchImpl,
    sessions: { '4pda.to': { cookie: 'bb_session=secret' } },
  });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].cookie, 'bb_session=secret');
  assert.match(page.text, /Members only/);
});
