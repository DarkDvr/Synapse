// The descriptions a model reads.
//
// They are the only documentation it gets: the tool list rides in its context on every
// request, and it cannot experiment with a server the way a person experiments with a CLI.
// So these are pinned — a description that describes the previous design is worse than a
// short one, and `handoff` described a minimised window for a release after it had become a
// permission card (13 Nov).
//
// The descriptions live in their own module for exactly this reason: importing
// `browser-server.js` starts the stdio server, which waits on stdin for ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/mcp/browser-tools.js';

const text = (name) => {
  const tool = TOOLS.find((t) => t.name === name);
  assert.ok(tool, `${name} is a tool`);
  return tool.description;
};

test('open says the window is hidden, what it may open, and that sessions persist', () => {
  const d = text('open');
  assert.match(d, /hidden/i, 'the operator sees nothing');
  assert.match(d, /http and https/, 'http(s) pages open');
  assert.match(d, /local \.html\/\.htm page/, 'a local mock is a page too');
  assert.match(d, /inside the projects folder/, 'and the fence is named');
  assert.doesNotMatch(d, /file:\/\/ is refused/, 'the old blanket refusal is gone');
  assert.match(d, /sessions between runs/i, 'the profile is the point');
  assert.match(d, /handoff/, 'a wall is not a scrape');
  assert.doesNotMatch(d, /a host the operator has a browser refuses/, 'the host list is gone');
});

test('read says how much it returns and that a cut is marked', () => {
  const d = text('read');
  assert.match(d, /6000 by default/, 'the default is named');
  assert.match(d, /100000 at most/, 'the ceiling is named');
  assert.match(d, /full: true/, 'and the whole-page route');
  assert.match(d, /cut is marked/i, 'the model must know when it is reading a cut');
});

test('handoff describes the card, not the window it used to open', () => {
  const d = text('handoff');
  assert.match(d, /card/i, 'it is a permission');
  assert.match(d, /Allow Sign-In/, 'the operator’s own words for the button');
  assert.match(d, /no time limit|without a time limit/i, 'it waits for a person');
  assert.doesNotMatch(d, /minimi[sz]ed/i, 'the window is not minimised any more');
  assert.doesNotMatch(d, /second monitor/i, 'the window is on the operator’s monitor now');
});

test('screenshot gives a path the chat can render', () => {
  const d = text('screenshot');
  assert.match(d, /\.synapse\\browser\\shots/, 'the project folder');
  assert.match(d, /relative path/, 'and the chat-ready one');
});

// A model that needed to press "7" was told "unknown key: 7" (14 Nov): the tool only knew
// names. The description now says a character is a key, and `type` says why it is not.
test('press takes a character, and type says it cannot', () => {
  const p = text('press');
  assert.match(p, /printable character/, 'a character is a key');
  assert.match(p, /"7"/, 'the example is the one that failed');
  assert.match(p, /keydown/, 'and it fires key events');
  const t = text('type');
  assert.match(t, /does not fire key events/, 'type explains the difference');
});

test('every tool has a description and a schema', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} says what it does`);
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} has an object schema`);
  }
  assert.equal(TOOLS.length, 12, 'the twelve tools the brief names');
});
