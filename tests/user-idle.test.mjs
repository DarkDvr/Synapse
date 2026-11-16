// The system's last-input clock, which is not the same as Synapse's quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { userIdleMs, IDLE_SCRIPT } from '../src/user-idle.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

test('the question is GetLastInputInfo', () => {
  assert.match(IDLE_SCRIPT, /GetLastInputInfo/);
  assert.match(IDLE_SCRIPT, /Environment\.TickCount/);
});

test('another platform has no answer, and that is null', async () => {
  assert.equal(await userIdleMs({ platform: 'linux' }), null);
});

test('the answer is the last line PowerShell printed', async () => {
  const child = fakeChild();
  const pending = userIdleMs({ platform: 'win32', spawnFn: () => child, timeoutMs: 100 });
  child.stdout.emit('data', 'Add-Type: a warning\n1015\n');
  child.emit('close');
  assert.equal(await pending, 1015);
});

test('a garbled answer is null, not zero', async () => {
  const child = fakeChild();
  const pending = userIdleMs({ platform: 'win32', spawnFn: () => child, timeoutMs: 100 });
  child.stdout.emit('data', 'not a number\n');
  child.emit('close');
  assert.equal(await pending, null);
});

test('a process that never answers is null', async () => {
  const child = fakeChild();
  const pending = userIdleMs({ platform: 'win32', spawnFn: () => child, timeoutMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await pending, null);
  assert.equal(child.killed, true);
});
