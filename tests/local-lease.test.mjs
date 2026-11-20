// One turn at a time per local server (20 Nov).
//
// The failure this exists for: two projects on the same local model server, both
// turns sending their whole prompt at once. The server re-reads both, may reload a
// different model between them, and both crawl — "the model got slow" was really two
// turns on one server. The harness holds a lease per server and the second turn waits.
//
// These assert the rules without an engine: which models are local, and the queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { localServer, createLocalLease } from '../src/local-lease.js';

const CONFIG = {
  engine: {
    opencode: {
      providers: [
        { id: 'local', name: 'Local LLM', type: 'local', baseURL: 'http://localhost:1235/v1' },
        { id: 'polystrata', name: 'PolyStrata', type: 'openai', baseURL: 'http://127.0.0.1:8080/v1' },
        { id: 'oc-go', name: 'OpenCode Go', type: 'openai', baseURL: 'https://opencode.ai/zen/go/v1' },
      ],
    },
  },
};

test('a localhost address is a local server, whatever its type says', () => {
  const server = localServer(CONFIG, 'polystrata/qwen3.8-flash');
  assert.equal(server.label, 'PolyStrata');
  assert.match(server.key, /127\.0\.0\.1:8080/);
  assert.equal(localServer(CONFIG, 'local/some-model')?.label, 'Local LLM');
});

test('a cloud model never waits, and a ref without a provider is not a server', () => {
  assert.equal(localServer(CONFIG, 'oc-go/deepseek-v4.1-flash'), null);
  assert.equal(localServer(CONFIG, 'unknown-model'), null);
  assert.equal(localServer(CONFIG, ''), null);
});

test('the second turn on one server waits for the first, and gets it in order', async () => {
  const lease = createLocalLease();
  const server = localServer(CONFIG, 'polystrata/a');
  const order = [];
  const first = await lease.acquire({ serverKey: server.key, label: server.label, sessionId: 's1', holder: 'Alpha - Coder 1 t1' });
  assert.ok(first, 'the first turn takes the server');
  const second = lease.acquire({ serverKey: server.key, label: server.label, sessionId: 's2', holder: 'Beta - Coder 1 t1' }).then((h) => {
    order.push('second');
    return h;
  });
  const third = lease.acquire({ serverKey: server.key, label: server.label, sessionId: 's3', holder: 'Gamma' }).then((h) => {
    order.push('third');
    return h;
  });
  // Nothing moves while the first turn holds it.
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, []);
  assert.equal(lease.state().queue.length, 2);
  assert.equal(lease.holderOf(server.key)?.sessionId, 's1');

  lease.release(first);
  const h2 = await second;
  assert.deepEqual(order, ['second']);
  assert.equal(h2.sessionId, 's2', 'the first waiter gets it, not the last');

  lease.release(h2);
  const h3 = await third;
  assert.deepEqual(order, ['second', 'third']);
  lease.release(h3);
  assert.deepEqual(lease.state(), { held: [], queue: [] });
});

test('a turn is freed by its session’s idle, and a waiting turn can be cancelled', async () => {
  const lease = createLocalLease();
  const server = localServer(CONFIG, 'polystrata/a');
  const held = await lease.acquire({ serverKey: server.key, label: server.label, sessionId: 's1', holder: 'Alpha' });
  const waiting = lease.acquire({ serverKey: server.key, label: server.label, sessionId: 's2', holder: 'Beta' });
  assert.equal(lease.waiting('s2'), true);
  lease.releaseSession('s2'); // Stop pressed while it waited
  assert.equal(await waiting, null);
  lease.releaseSession('s1'); // the engine's idle
  assert.equal(lease.holderOf(server.key), null);
  assert.equal(held.sessionId, 's1');
});

test('two different local servers do not wait for each other', async () => {
  const config = {
    engine: { opencode: { providers: [...CONFIG.engine.opencode.providers, { id: 'other', name: 'Other', type: 'local', baseURL: 'http://127.0.0.1:9999/v1' }] } },
  };
  const lease = createLocalLease();
  const a = localServer(config, 'polystrata/a');
  const b = localServer(config, 'other/b');
  const first = await lease.acquire({ serverKey: a.key, label: a.label, sessionId: 's1', holder: 'Alpha' });
  const second = await lease.acquire({ serverKey: b.key, label: b.label, sessionId: 's2', holder: 'Beta' });
  assert.ok(first && second, 'one server waiting must not block the other');
  lease.release(first);
  lease.release(second);
});

test('a waiting chat is described, and the description goes when its turn starts', async () => {
  const lease = createLocalLease();
  const server = localServer(CONFIG, 'polystrata/a');
  const held = await lease.acquire({
    serverKey: server.key,
    label: server.label,
    sessionId: 's1',
    holder: 'VPA - coder-1 b1',
    dir: 'F:\\p\\vpa',
  });
  const waiting = lease.acquire({
    serverKey: server.key,
    label: server.label,
    sessionId: 's2',
    holder: 'test - your message',
    dir: 'F:\\p\\test',
    kind: 'send',
  });
  const described = lease.forDir('F:\\p\\test');
  assert.equal(described.waiting.kind, 'send');
  assert.match(described.held.holder, /VPA/);
  assert.equal(lease.forDir('F:\\p\\vpa'), null, 'the holder is not waiting');
  lease.release(held);
  const granted = await waiting;
  assert.equal(lease.forDir('F:\\p\\test'), null, 'the post must go when the turn starts');
  lease.release(granted);
});

test('a wait that times out is null, not a turn', async () => {
  const lease = createLocalLease();
  const server = localServer(CONFIG, 'polystrata/a');
  const held = await lease.acquire({ serverKey: server.key, label: server.label, sessionId: 's1', holder: 'Alpha' });
  const timed = await lease.acquire({ serverKey: server.key, label: server.label, sessionId: 's2', holder: 'Beta', waitMs: 25 });
  assert.equal(timed, null);
  assert.equal(lease.state().queue.length, 0, 'a timed-out waiter left the queue');
  assert.equal(lease.holderOf(server.key)?.sessionId, 's1', 'and took nothing');
  lease.release(held);
});
