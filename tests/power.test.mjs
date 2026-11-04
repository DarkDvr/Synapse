// The wake lock: what Windows is asked, and how the ask is managed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { wakeScript, createPowerKeeper } from '../src/power.js';
import { normalize } from '../src/config.js';

const logger = { channel: () => ({ info() {}, warn() {}, error() {}, debug() {} }) };

function fakeSpawn() {
  const calls = [];
  const spawnFn = (file, args) => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    calls.push({ file, args, child });
    return child;
  };
  return { spawnFn, calls };
}

test('the wake lock asks for the system, and the display only when told', () => {
  const system = wakeScript({ display: false, ownerPid: 123 });
  assert.match(system, /SetThreadExecutionState/);
  assert.match(system, /\$ES_FLAGS = 2147483649/, 'ES_CONTINUOUS | ES_SYSTEM_REQUIRED');
  assert.match(system, /\$owner = 123/);
  assert.match(system, /\[uint32\]\$ES_FLAGS/, 'a negative Int32 is refused by the API');

  const shown = wakeScript({ display: true, ownerPid: 123 });
  assert.match(shown, /\$ES_FLAGS = 2147483651/, 'ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED');
});

test('the lock starts, changes its flags once, and stops', () => {
  const { spawnFn, calls } = fakeSpawn();
  const keeper = createPowerKeeper({ logger, spawnFn, ownerPid: 5 });

  assert.equal(keeper.state().awake, false);
  let state = keeper.apply({ keepAwake: false });
  assert.equal(state.awake, false);
  assert.equal(calls.length, 0);

  state = keeper.apply({ keepAwake: true, keepDisplay: false });
  assert.equal(state.awake, true);
  assert.equal(state.display, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'powershell.exe');

  // The same ask is not a second child.
  keeper.apply({ keepAwake: true, keepDisplay: false });
  assert.equal(calls.length, 1);

  // The amplified half is a new request: the old child must not hold old flags.
  state = keeper.apply({ keepAwake: true, keepDisplay: true });
  assert.equal(state.display, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].child.killed, true, 'the first lock was released');

  state = keeper.apply({ keepAwake: false, keepDisplay: true });
  assert.equal(state.awake, false);
  assert.equal(calls[1].child.killed, true);
});

test('keepAwake and keepDisplay are booleans, and display alone does nothing', () => {
  const cfg = normalize({ automation: { keepAwake: true, keepDisplay: 'yes' } });
  assert.equal(cfg.automation.keepAwake, true);
  assert.equal(cfg.automation.keepDisplay, false, 'only a real true counts');
  const blank = normalize({});
  assert.equal(blank.automation.keepAwake, false);
  assert.equal(blank.automation.keepDisplay, false);
});
