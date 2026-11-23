// The browser half of the search fallback, without launching a browser.
//
// The selectors are the fragile part: DuckDuckGo's classes are generated and change
// between builds, while `data-testid="result"`, `data-testid="result-title-a"` and
// `data-result="snippet"` are the page's own names for what a result is. The live
// check happens in the search_lab project; these cases keep the pure logic honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  normalizeBrowserResults,
  decodeDdgRedirect,
  decodeBingRedirect,
  BROWSER_ENGINES,
} from '../src/browser/search.js';

test('a DuckDuckGo redirect is unwrapped and a plain URL is kept', () => {
  assert.equal(
    decodeDdgRedirect('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fmod&rut=x'),
    'https://example.com/mod',
  );
  assert.equal(decodeDdgRedirect('https://example.com/plain'), 'https://example.com/plain');
});

test('a Bing redirect is decoded from the u=a1 payload', () => {
  assert.equal(
    decodeBingRedirect('https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9yZWxlYXNlcw'),
    'https://example.com/releases',
  );
  assert.equal(decodeBingRedirect('https://example.com/plain'), 'https://example.com/plain');
});

test('browser results are deduped, dated and given a source', () => {
  const out = normalizeBrowserResults([
    {
      title: 'Mod page',
      url: 'https://www.nexusmods.com/skyrimspecialedition/mods/1',
      snippet: 'May 22, 2025Batch - a tool.',
      source: 'https://www.nexusmods.com › skyrimspecialedition',
    },
    { title: 'Duplicate', url: 'https://www.nexusmods.com/skyrimspecialedition/mods/1', snippet: 'again' },
    { title: 'Other', url: 'https://example.com/x', snippet: 'No date here.', source: 'example.com' },
  ], 5);
  assert.equal(out.length, 2);
  assert.equal(out[0].published, 'May 22, 2025');
  assert.equal(out[0].snippet, 'Batch - a tool.');
  assert.equal(out[0].source, 'nexusmods.com');
  assert.equal(out[1].published, '');
});

test('the page order is DuckDuckGo, Lite, then Bing', () => {
  assert.deepEqual(BROWSER_ENGINES.map((e) => e.id), ['duckduckgo', 'duckduckgo-lite', 'bing']);
  for (const engine of BROWSER_ENGINES) {
    const script = engine.extract(3);
    assert.match(script, /const limit = 3/, `${engine.id} ignores the limit`);
    assert.match(script, /https\?:/, `${engine.id} has no URL check`);
  }
  assert.match(BROWSER_ENGINES[0].extract(3), /result-title-a/);
  assert.match(BROWSER_ENGINES[0].extract(3), /data-result="snippet"/);
  assert.match(BROWSER_ENGINES[2].extract(3), /b_algo/);
});

test('the search browser never creates a window or a tab', () => {
  const src = fs.readFileSync(new URL('../src/browser/search.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /send\('Target\.createTarget'/, 'a CDP target is a visible WebView2 window');
  assert.match(src, /Page\.navigate/, 'the one off-screen page is navigated instead');
  assert.match(src, /searchBrowser/, 'the search has its own host, not the model browser');
  assert.match(src, /'search', 'webview2'/, 'the search host must not share the main host state file');
});
