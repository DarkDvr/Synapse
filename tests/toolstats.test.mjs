// The tool census, and the one thing it must not do: count the same call twice.
//
// A transcript is re-read in full on every turn, and the runner scans it as well, so
// the census de-duplicates by tool-part id. Those ids used to live only in memory
// while the totals went to disk, so the first turn after a restart re-added a whole
// session's history (measured: 2 calls -> restart -> 4). `seen` is persisted now;
// this pins that, and it pins the case the fix cannot help (a census written before
// ids were kept), which must say so rather than be quietly wrong.
//
// Two traps this file exists to remember:
//  - `flush()` is debounced by 2s, so a test that does not call it never reaches disk
//    and looks clean while proving nothing;
//  - the ids are capped, so a "restart" test must move the file, not the instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createToolStats } from '../src/toolstats.js';
import { tmpdir } from './tmpdir.mjs';

function fixture() {
  const dir = tmpdir('synapse-census-');
  const file = path.join(dir, 'tool-stats.json');
  const lines = [];
  const logger = {
    channel: () => ({
      info: (m) => lines.push(['info', m]),
      warn: (m) => lines.push(['warn', m]),
      error: (m) => lines.push(['error', m]),
      debug: () => {},
    }),
  };
  return { dir, file, lines, logger };
}

const messages = [
  { parts: [{ type: 'tool', id: 'prt_one', name: 'read', failed: false, ms: 12 }] },
  { parts: [{ type: 'tool', id: 'prt_two', name: 'shell', failed: true, exitCode: 1, ms: 300 }] },
];

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const logger = { channel: () => quiet };

test('a transcript scanned twice in one process counts once', () => {
  const f = fixture();
  const stats = createToolStats({ file: f.file, logger: f.logger });
  assert.equal(stats.recordMessages(messages), 2);
  assert.equal(stats.recordMessages(messages), 0);
  stats.flush();
  assert.equal(stats.snapshot().total, 2);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('a restart does not re-count the transcript it already counted', () => {
  const f = fixture();
  const first = createToolStats({ file: f.file, logger: f.logger });
  first.recordMessages(messages);
  first.flush();

  // "Restart": a new process, the same file on disk.
  const second = createToolStats({ file: f.file, logger: f.logger });
  assert.equal(second.snapshot().total, 2, 'the totals came back from disk');
  assert.equal(second.recordMessages(messages), 0, 'and the same parts are not counted again');
  second.flush();
  assert.equal(second.snapshot().total, 2);

  const third = createToolStats({ file: f.file, logger: f.logger });
  assert.equal(third.snapshot().total, 2, 'a second restart is still 2');
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('a census written before ids were kept says so, and is the one case it cannot fix', () => {
  const f = fixture();
  // The shape an older build left behind: totals, no ids.
  fs.writeFileSync(f.file, JSON.stringify({ total: 2, failed: 0, tools: { read: { calls: 2, failed: 0, ms: 0 } }, seen: [] }));
  const stats = createToolStats({ file: f.file, logger: f.logger });
  assert.equal(stats.snapshot().total, 2);
  assert.ok(
    f.lines.some(([level, m]) => level === 'warn' && /predates id tracking/.test(m)),
    'it warns instead of being quietly wrong',
  );
  // Documented behaviour, not a claim of a fix: without ids it must count again.
  assert.equal(stats.recordMessages(messages), 2);
  assert.equal(stats.snapshot().total, 4);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('clearing the census clears the ids with it, so the next scan counts again', () => {
  const f = fixture();
  const stats = createToolStats({ file: f.file, logger: f.logger });
  stats.recordMessages(messages);
  stats.clear();
  assert.equal(stats.snapshot().total, 0);
  assert.equal(stats.recordMessages(messages), 2, 'keeping the ids would make the census silently count nothing');
  assert.equal(stats.snapshot().total, 2);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('a failed call is counted where it happened', () => {
  const f = fixture();
  const stats = createToolStats({ file: f.file, logger: f.logger });
  stats.recordMessages(messages, { model: 'some/model', agent: 'coder-1', sessionId: 'ses_x' });
  const snap = stats.snapshot();
  assert.equal(snap.total, 2);
  assert.equal(snap.failed, 1);
  assert.equal(snap.tools.find((t) => t.key === 'shell').failed, 1);
  assert.equal(snap.exits['1'], 1);
  assert.equal(snap.recentErrors.length, 1);
  assert.equal(snap.recentErrors[0].sessionId, 'ses_x');
  fs.rmSync(f.dir, { recursive: true, force: true });
});
