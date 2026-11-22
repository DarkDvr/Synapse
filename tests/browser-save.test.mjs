// What `save` says after fetching a URL through the page, and what a bot check is called.
//
// The two mistakes these pin were made in one run (22 Nov): a "download" address that
// answered an HTML page was taken as a file, and a captcha wall was clicked into for
// nothing. Both are sentences a model acts on, so both are tested without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { botWall, savedAnswer, requestAnswer, domAnswer } from '../src/browser/browser.js';

test('a fetch that returned a page is not a file, and says so', () => {
  const answer = savedAnswer({
    ok: true,
    type: 'text/html; charset=utf-8',
    size: 48_000,
    head: '<!DOCTYPE html><html><head><title>Music Mods Merged</title>',
  });
  assert.equal(answer.isError, true, 'an HTML answer is a file');
  assert.match(answer.text, /answered a \*\*page\*\*, not a file/, 'the answer does not say what happened');
  assert.match(answer.text, /download control/, 'it does not say how to get the file');
});

test('a page that answers with the 200 of a route is caught by its first bytes too', () => {
  const answer = savedAnswer({ ok: true, type: 'application/octet-stream', size: 900, head: '<html><body>Sign in' });
  assert.equal(answer.isError, true, 'a page served as a file type was saved');
});

test('a real file is saved and named, and nothing else is claimed', () => {
  const answer = savedAnswer({
    ok: true,
    type: 'application/zip',
    size: 86_820,
    name: 'Music Merged-4625-1-4-2.zip',
    from: 'https://cdn.example/Music%20Merged.zip',
  }, { dir: 'F:/p', rel: '.project/downloads/Music Merged-4625-1-4-2.zip' });
  assert.equal(answer.isError, false);
  assert.match(answer.text, /Saved Music Merged-4625-1-4-2.zip/);
  assert.match(answer.text, /85 KB/);
  assert.match(answer.text, /\.project\/downloads\//);
});

test('a refused address says what it answered, and that nothing was saved', () => {
  const answer = savedAnswer({ ok: false, status: 403, said: 'Access denied' });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /answered 403/);
  assert.match(answer.text, /Nothing was saved/);
});

test('a file too large to fetch through the page is told to use download', () => {
  const answer = savedAnswer({ ok: false, tooBig: 900 * 1024 * 1024 });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /larger than a fetch/);
  assert.match(answer.text, /download/);
});

test('a bot check is named, and a sign-in wall is not mistaken for one', () => {
  assert.match(botWall('Please verify you are human to continue'), /bot check/);
  assert.match(botWall('', 'https://www.google.com/recaptcha/api.js'), /bot check/);
  assert.match(botWall('Checking your browser before accessing'), /bot check/);
  // What Nexus actually served on 22 Nov, through Cloudflare.
  assert.match(botWall('Just a moment... Enable JavaScript and cookies to continue'), /bot check/);
  assert.equal(botWall('Sign in to your account', 'https://example.com/login.js'), '', 'a sign-in page is a captcha');
  assert.equal(botWall('A perfectly ordinary page about music'), '');
});

// The request half of save: a site's own script asks for a link, and the answer names it.
test('a JSON answer that names a link says so, and what to do with it', () => {
  const answer = requestAnswer({
    ok: true,
    status: 200,
    type: 'application/json',
    text: '{"url":"https://supporter-files.nexus-cdn.com/1704/4625/Music%20Merged.zip?md5=abc&expires=1&user_id=9"}',
  });
  assert.equal(answer.isError, false);
  assert.match(answer.text, /names a link/);
  assert.match(answer.text, /supporter-files\.nexus-cdn\.com/);
  assert.match(answer.text, /Save that address/, 'the next move is not named');
});

test('a refused request keeps the site’s words and any Retry-After', () => {
  const answer = requestAnswer({ ok: false, status: 403, retry: 30, text: '<html><title>Just a moment...</title>' });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /answered 403/);
  assert.match(answer.text, /wait 30 s/);
});

test('dom answers what each element states, attributes included', () => {
  const text = domAnswer('[data-file-id]', [
    { tag: 'a', text: 'Music Merged', at: [1037, 564], attrs: { 'data-file-id': '245273', href: '/files/245273' } },
  ]);
  assert.match(text, /1 element for \[data-file-id\]/);
  assert.match(text, /<a> \(1037,564\) “Music Merged”/);
  assert.match(text, /data-file-id="245273"/);
});
