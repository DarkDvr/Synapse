// The brief must be on the model before the turn starts.
//
// 13 Nov, calc-emperor: a chat created in Single, switched to Multi and sent at once. The
// engine created the user message at 19:12:08.362 and applied the instruction entry at
// .370 — eight milliseconds later. The turn ran on the brief from creation ("do the work
// yourself, there is no team, ignore a delegation tool"), so the model built the whole
// calculator itself; the engine announced the change at the *next* turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OpenCodeEngine } from '../src/engines/opencode.js';

const silentLogger = () => ({ channel: () => ({ debug() {}, info() {}, warn() {}, error() {} }) });
const engine = () => {
  const e = new OpenCodeEngine({}, { logger: silentLogger() });
  e.request = async () => ({});
  return e;
};

test('setInstruction waits for the engine to apply the write', async () => {
  const e = engine();
  let settled = false;
  const p = e.setInstruction('ses_x', 'synapse.plan', 'brief').then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(settled, false, 'the PUT is accepted, but the call is still waiting');
  e.handleEvent({ type: 'session.instructions.updated', sessionID: 'ses_x' });
  await p;
  assert.equal(settled, true, 'the event lets the caller prompt');
});

test('another session’s update does not release the wait', async () => {
  const e = engine();
  const p = e.setInstruction('ses_x', 'synapse.plan', 'brief');
  e.handleEvent({ type: 'session.instructions.updated', sessionID: 'ses_other' });
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(settled, false, 'the wait is per session');
  e.handleEvent({ type: 'session.instructions.updated', sessionID: 'ses_x' });
  await p;
});

test('a missing confirmation times out instead of hanging the turn', async () => {
  const e = engine();
  const ok = await e.awaitInstruction('ses_none', Date.now(), 40);
  assert.equal(ok, false, 'reported as not confirmed');
});

// The model that did delegate then spent ten reads of plan.json waiting inside its own
// turn for a run that cannot start until the turn ends (calc-emperor-strict). The tool's
// reply must close that door in words, not only in the tool description.
test('the delegate receipt tells the model to end its turn', () => {
  const src = fs.readFileSync(new URL('../src/mcp/delegate-server.js', import.meta.url), 'utf8');
  assert.match(src, /End this turn now\./, 'the receipt says what to do');
  assert.match(src, /never show it running/, 'and why waiting inside the turn is useless');
});
