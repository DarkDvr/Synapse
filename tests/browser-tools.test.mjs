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
import fs from 'node:fs';
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
  assert.match(d, /\.project\\browser\\shots/, 'the project folder');
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

test('download says where it goes, and that click waits for a file', () => {
  const d = text('download');
  assert.match(d, /\.project\/downloads/, 'the project folder is named');
  assert.match(d, /progress bar/, 'the chat shows progress');
  assert.match(d, /never overwritten/, 'a collision is a new name, not a lost file');
  assert.match(d, /click/i, 'a click that downloads is the common route');
});

test('snapshot is the action surface: named refs, and a fresh one after a change', () => {
  const d = text('snapshot');
  assert.match(d, /ref/, 'the ref is the point');
  assert.match(d, /Manual download|button/, 'it shows the shape of a control');
  assert.match(d, /take a new one|re-?snapshot/i, 'refs do not survive navigation');
  assert.match(d, /covered|hidden/i, 'a click that misses says so');
  assert.match(d, /no selector/i, 'a dialog needs a plain snapshot');
  const dom = text('dom');
  assert.match(dom, /shadow root/i, 'dom names its shadow-root blind spot');
  const click = text('click');
  assert.match(click, /ref/i, 'click takes the ref');
  assert.match(click, /prefer/i, 'and prefers it over a coordinate');
  const type = text('type');
  assert.match(type, /clears the field/i, 'a ref fills rather than appends');
});

test('every tool has a description and a schema', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} says what it does`);
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} has an object schema`);
  }
  assert.equal(TOOLS.length, 16, 'the sixteen tools: snapshot is the newest');
});

// A timeout is the moment a model needs the most information: "did not happen" says
// nothing about whether to open something, change the spelling, or read the page. The
// answer now says which kind of absence it found (14 Nov).
test('wait explains a timeout as missing, or in the page and not shown', () => {
  const d = text('wait');
  assert.match(d, /not shown/i, 'the two absences are named');
  assert.match(d, /collapsed comment/i, 'with the shape a page actually has');
  assert.match(d, /read` is cheaper|read is cheaper/i, 'and the cheaper way to check now');
  const src = fs.readFileSync(new URL('../src/mcp/browser-server.js', import.meta.url), 'utf8');
  assert.match(src, /Not shown:/, 'the server says which one it was');
  assert.match(src, /Not there:/);
});

