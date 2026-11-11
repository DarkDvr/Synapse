// The Sites record: which hosts SynaBrowse is signed into, and how old the session is.
//
// It is a record, not a permission list, so the tests are about honesty: one row per
// host, a date that only moves forward, and no invented lifetime — the table shows an
// age, because when a session expires is the site's decision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHost, normalizeSites, addSite, touchSite, forgetSite } from '../src/browser/sites.js';

test('a host is a host, whatever was typed', () => {
  assert.equal(cleanHost('https://www.Example.test/r/x?y=1'), 'www.example.test');
  assert.equal(cleanHost('example.test'), 'example.test');
  assert.equal(cleanHost('example.test:8080'), 'example.test');
  assert.equal(cleanHost('.example.test.'), 'example.test');
  assert.equal(cleanHost(''), '');
  assert.equal(cleanHost('not a host'), '', 'a space is not a host');
});

test('a saved list is de-duplicated and newest first', () => {
  const list = normalizeSites([
    { host: 'a.test', signedInAt: 100 },
    { host: 'B.test', signedInAt: 300 },
    { host: 'a.test', signedInAt: 200 },
    'c.test',
    { nope: true },
    null,
  ]);
  assert.deepEqual(list.map((entry) => entry.host), ['b.test', 'a.test', 'c.test']);
  assert.equal(list.find((entry) => entry.host === 'a.test').signedInAt, 200, 'the newer sign-in wins');
});

test('signing in adds or refreshes exactly one row, with its address', () => {
  const first = addSite([], 'example.test', 1000, 'https://www.example.test/');
  assert.deepEqual(first, [{
    host: 'example.test',
    url: 'https://www.example.test/',
    signedInAt: 1000,
    lastUsedAt: 1000,
  }]);
  const again = addSite(first, 'https://example.test/', 2000);
  assert.equal(again.length, 1, 'one row per host');
  assert.equal(again[0].signedInAt, 2000);
  assert.equal(again[0].url, 'https://www.example.test/', 'a refresh keeps the address it was confirmed at');
});

test('opening a site the profile has a session for moves "last used" only', () => {
  const list = addSite([], 'example.test', 1000);
  const used = touchSite(list, 'example.test', 5000);
  assert.equal(used[0].signedInAt, 1000, 'a visit is not a sign-in');
  assert.equal(used[0].lastUsedAt, 5000);
  // A host that was never signed in does not appear from a visit.
  assert.deepEqual(touchSite([], 'other.test', 1), []);
});

test('forgetting removes the row and nothing else', () => {
  const list = addSite(addSite([], 'a.test', 1), 'b.test', 2);
  assert.deepEqual(forgetSite(list, 'A.TEST').map((entry) => entry.host), ['b.test']);
});
