// A download's name, bar and chip, without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { safeDownloadName, uniqueDownloadPath, formatBytes, progressBar } from '../src/browser/downloads.js';
import { downloadBody, downloadAt, downloadsInWindow } from '../web/downloads.js';
import { createApi } from '../src/api.js';
import { PROJECTS_ROOT } from '../src/paths.js';
import { tmpdir } from './tmpdir.mjs';

test('a suggested filename becomes one safe leaf', () => {
  assert.equal(safeDownloadName('report.pdf'), 'report.pdf');
  assert.equal(safeDownloadName('..\\..\\Windows\\evil.exe'), 'Windows evil.exe');
  assert.equal(safeDownloadName('a/b:c*?.txt'), 'a b c .txt');
  assert.equal(safeDownloadName('CON.txt'), '_CON.txt');
  assert.equal(safeDownloadName('  .  '), 'download');
  assert.equal(safeDownloadName('x'.repeat(300)).length, 120);
});

test('an existing file is never overwritten', () => {
  const dir = tmpdir('synapse-downloads-');
  fs.writeFileSync(path.join(dir, 'report.pdf'), 'old');
  const next = uniqueDownloadPath(dir, 'report.pdf');
  assert.equal(path.basename(next), 'report (1).pdf');
  fs.writeFileSync(next, 'new');
  assert.equal(path.basename(uniqueDownloadPath(dir, 'report.pdf')), 'report (2).pdf');
});

test('bytes and the ASCII bar read the same everywhere', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(progressBar(0, 100), '[------------------------]');
  assert.equal(progressBar(50, 100), '[############------------]');
  assert.equal(progressBar(100, 100), '[########################]');
  assert.equal(progressBar(3, 0), '[------------------------]');
});

test('the chat chip carries the name, the bar and the saved path', () => {
  const html = downloadBody({
    id: 'g1',
    name: 'report.pdf',
    received: 100,
    total: 100,
    state: 'completed',
    path: '.project/downloads/report.pdf',
    startedAt: 1,
  });
  assert.match(html, /SynaBrowse · Download/);
  assert.match(html, /report\.pdf/);
  assert.match(html, /\[########################\]/);
  assert.match(html, /Saved/);
  assert.match(html, /\.project\/downloads\/report\.pdf/);
  assert.match(html, /100%/);
});

test('a download stays with the action that started it, not where it finished', () => {
  // The card belongs to the click/download call, so it sits among the tool calls above
  // the report even when the file finishes after the report has begun (22 Nov).
  assert.equal(downloadAt({ state: 'inProgress', startedAt: 1 }), 1);
  assert.equal(downloadAt({ state: 'completed', startedAt: 1, endedAt: 4242 }), 1);
  // And it folds to its head: the bar, the bytes and the path were the live state.
  const css = fs.readFileSync(new URL('../web/synapse.css', import.meta.url), 'utf8');
  assert.match(css, /\.tool-download\.is-done \.download-body \{ display: none; \}/);
});

test('a card belongs to the post it happened in, not the bottom of the page', () => {
  const before = { id: 'before', state: 'completed', startedAt: 900, endedAt: 950 };
  const saved = { id: 'saved', state: 'completed', startedAt: 1500, endedAt: 1600 };
  const late = { id: 'late', state: 'completed', startedAt: 1500, endedAt: 2500 };
  const live = { id: 'live', state: 'inProgress', startedAt: 1900 };
  // The window is one post: from its start to the next post's start.
  assert.deepEqual(downloadsInWindow([before, saved, live], 1000, 2000).map((d) => d.id), ['saved', 'live']);
  // A finish after the next post's start does not move the card into that post.
  assert.deepEqual(downloadsInWindow([late], 1000, 2000).map((d) => d.id), ['late']);
  // The newest post has no next one.
  assert.deepEqual(downloadsInWindow([saved, live], 1000).map((d) => d.id), ['saved', 'live']);
  assert.deepEqual(downloadsInWindow([saved], 2000), []);
});

test('a failed download says so instead of a path', () => {
  const html = downloadBody({
    id: 'g2',
    name: 'big.iso',
    received: 10,
    total: 100,
    state: 'interrupted',
    error: 'net::ERR_FAILED',
    startedAt: 1,
  });
  assert.match(html, /Failed/);
  assert.match(html, /net::ERR_FAILED/);
  assert.doesNotMatch(html, /Saved/);
});

// The API's memory: the browser process reports progress, the page reads it back, and a
// path outside the projects folder is refused rather than becoming a chat filename.
function apiHarness() {
  const events = [];
  const api = createApi({
    getConfig: () => ({}),
    applyConfig: async () => {},
    engine: { status: () => ({ ready: true, kind: 'stub' }) },
    logger: { channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }) },
    getBootError: () => null,
    projects: {},
    toolStats: null,
    probe: null,
    modelCache: null,
    inspectModel: null,
    probeDir: null,
    runs: null,
    engineUpdate: null,
    synapseUpdate: null,
    restart: null,
    stopSelf: null,
    notify: (ev) => events.push(ev),
    permissionLog: null,
    permissionGate: null,
    permissionMemory: null,
  });
  return { api, events };
}

test('the API keeps a download for the page and refuses a folder outside the projects', async () => {
  const { api, events } = apiHarness();
  const dir = path.join(PROJECTS_ROOT, 'download-api-test');
  const ok = await api.browserDownload({
    dir,
    id: 'g1',
    name: 'report.pdf',
    received: 5,
    total: 10,
    state: 'inProgress',
    startedAt: 1,
  });
  assert.equal(ok.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'browser-download');
  const listed = await api.browserDownloads(dir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'report.pdf');
  assert.equal(listed[0].received, 5);
  const outside = await api.browserDownload({
    dir: 'C:\\Windows\\System32',
    id: 'g2',
    name: 'evil.exe',
    state: 'completed',
  });
  assert.equal(outside.ok, false);
  assert.equal((await api.browserDownloads('C:\\Windows\\System32')).length, 0);
});
