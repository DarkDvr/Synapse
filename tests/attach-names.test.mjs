// Pasted pictures are named pic1, pic2, ... so a post can point at one of them.
//
// The incident this exists for (20 Nov): six screenshots pasted into one message arrived
// as six `image.png` files. The operator wrote "see pic 3" and neither the chips nor the
// model could tell which file that was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPastedImageName, namePasted } from '../web/attach-names.js';

const file = (name) => ({ name });

test('a clipboard screenshot is recognised, a name a person chose is not', () => {
  for (const name of ['image.png', 'image (1).png', 'pasted-image.png', 'blob', 'screenshot-2.jpg', 'attachment.png']) {
    assert.equal(isPastedImageName(name), true, `${name} should be a machine name`);
  }
  for (const name of ['logo.png', 'mock-2.html', 'notes.txt', 'image.png.bak', 'design/design.md']) {
    assert.equal(isPastedImageName(name), false, `${name} is the operator's name`);
  }
});

test('pasted pictures are numbered in order, and picked files keep their names', () => {
  const list = [file('logo.png'), file('image.png'), file('image (1).png'), file('notes.txt'), file('image.png')];
  namePasted(list);
  assert.deepEqual(
    list.map((f) => f.name),
    ['logo.png', 'pic1.png', 'pic2.png', 'notes.txt', 'pic3.png'],
  );
});

test('a format is kept, and a picture without an extension becomes a png', () => {
  const list = [file('image.jpeg'), file('blob')];
  namePasted(list);
  assert.deepEqual(list.map((f) => f.name), ['pic1.jpeg', 'pic2.png']);
});

test('renumbering a shorter list closes the gap', () => {
  const list = [file('image.png'), file('image.png'), file('image.png')];
  namePasted(list);
  list.splice(1, 1);
  namePasted(list);
  assert.deepEqual(list.map((f) => f.name), ['pic1.png', 'pic2.png']);
});
