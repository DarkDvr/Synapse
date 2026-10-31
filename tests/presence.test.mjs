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
