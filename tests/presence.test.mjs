// Who holds the Settings lock, and how a view can tell that it is not itself.
//
// Every view receives the same broadcast frame, so a frame cannot carry a per-client
// `yours` flag. The holder's id travels instead, and the page compares it with its own.
// Without that, a page closed its own Settings panel and announced that the settings
// were "now being edited on ANDREWS" — itself, on this PC, with no second view holding
// anything. Measured 31 Oct: opening Settings here and letting any view join (a second
// tab, a reload, a probe page) produced exactly that toast.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPresence } from '../src/presence.js';

const presence = () => createPresence({ hostname: 'THIS-PC', reverse: async () => [] });

test('the holder is named with the view that holds it', () => {
  const p = presence();
  p.join({ id: 'view-a', address: '127.0.0.1' });
  p.join({ id: 'view-b', address: '127.0.0.1' });
  assert.equal(p.holder(), null, 'nobody holds it yet');

  p.acquire('view-a');
  const holder = p.holder();
  assert.equal(holder.id, 'view-a', 'the id is what a broadcast can carry');
  assert.equal(holder.name, 'THIS-PC');
  assert.equal(typeof holder.since, 'number');
});

test('a view can tell its own lock from another view’s', () => {
  const p = presence();
  p.join({ id: 'view-a', address: '127.0.0.1' });
  p.join({ id: 'view-b', address: '127.0.0.1' });
  p.acquire('view-a');
  assert.equal(p.status('view-a').lock.yours, true);
  assert.equal(p.status('view-b').lock.yours, false);
  // The broadcast frame is the same for both: it carries the holder, not a flag.
  assert.equal(p.holder().id, 'view-a');
});

test('the lock goes with the view that held it', () => {
  const p = presence();
  p.join({ id: 'view-a', address: '127.0.0.1' });
  p.acquire('view-a');
  assert.equal(p.leave('view-a').released, true);
  assert.equal(p.holder(), null);
});

// 4 Nov: the Remote Access tooltip showed `192.168.1.115`, not the laptop's name.
// The lookup had answered — quietly, after the join frame went out — so the page
// was never told. And the address arrived IPv4-mapped, which `dns.reverse` cannot
// answer for at all.
test('a LAN view is named from its address, and every page is told when it arrives', async () => {
  const looked = [];
  let told = 0;
  const p = createPresence({
    hostname: 'THIS-PC',
    reverse: async (ip) => {
      looked.push(ip);
      return [`laptop-${String(ip).split('.').pop()}.local`];
    },
    onChange: () => {
      told += 1;
    },
  });
  const view = p.join({ id: 'view-a', address: '::ffff:192.168.1.5' });
  assert.equal(view.name, '192.168.1.5', 'the address stands in until the lookup answers');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(looked[0], '192.168.1.5', 'the mapped address is asked as its IPv4 form');
  assert.equal(p.byId('view-a').name, 'laptop-5', 'the resolved name replaces the address');
  assert.ok(told >= 1, 'and the page is told, or the tooltip keeps the address');
});

test('a lookup that fails is retried, and a name that never comes is left as the address', async () => {
  let tries = 0;
  const p = createPresence({
    hostname: 'THIS-PC',
    retryMs: 1,
    retries: 2,
    reverse: async () => {
      tries += 1;
      if (tries < 3) throw new Error('no PTR yet');
      return ['late-laptop'];
    },
  });
  p.join({ id: 'view-a', address: '192.168.1.9' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(tries, 3, 'the lookup was tried again');
  assert.equal(p.byId('view-a').name, 'late-laptop');

  const never = createPresence({ hostname: 'THIS-PC', retryMs: 1, retries: 1, reverse: async () => [] });
  never.join({ id: 'view-b', address: '192.168.1.10' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(never.byId('view-b').name, '192.168.1.10', 'the address is the honest fallback');
});
