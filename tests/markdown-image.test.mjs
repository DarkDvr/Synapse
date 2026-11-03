// A model showing the operator a picture.
//
// The transcript must not spend chat lines on a thumbnail nobody asked for: a
// local image in a message is a chip, and the picture appears on hover. A remote
// image is still an image, and anything that is not an image file is not a chip.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown } from '../web/md.js';

test('a local image becomes a chip carrying its path, not an inline picture', () => {
  const html = renderMarkdown('Here it is: ![the mock](.synapse/shots/mock.png)');
  assert.match(html, /class="chat-image"/);
  assert.match(html, /data-src=".synapse\/shots\/mock.png"/);
  assert.match(html, /the mock/);
  assert.match(html, /class="chat-image-tag"[^>]*>PNG</, 'the tag is the extension');
  assert.doesNotMatch(html, /<img/);
});

test('the tag is the file extension, JPEG for both spellings', () => {
  assert.match(renderMarkdown('![a](x.jpg)'), />JPEG</);
  assert.match(renderMarkdown('![a](x.jpeg)'), />JPEG</);
  assert.match(renderMarkdown('![a](x.png)'), />PNG</);
});

test('a picture on its own line follows the sentence it illustrates', () => {
  const html = renderMarkdown('Here it is:\n\n![the mock](.synapse/shots/mock.png)');
  assert.equal((html.match(/<p>/g) || []).length, 1, 'one paragraph, not two');
  assert.match(html, /Here it is:.*class="chat-image"/);
});

test('a remote image is still an image', () => {
  const html = renderMarkdown('![x](https://example.com/a.png)');
  assert.match(html, /<img src="https:\/\/example\.com\/a\.png"/);
  assert.doesNotMatch(html, /chat-image/);
});

test('a path that is not an image file is not a chip', () => {
  const html = renderMarkdown('![x](javascript:alert(1))');
  assert.doesNotMatch(html, /chat-image|<img/);
  assert.doesNotMatch(html, /javascript:/);
});

test('a Windows-style path is accepted as a chip', () => {
  const html = renderMarkdown('![shot](.synapse\\shots\\shot.PNG)');
  assert.match(html, /class="chat-image"/);
});
