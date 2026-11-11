// How a browser tool appears in the chat.
//
// The model's tools arrive named `synapse-browser_open`, and a tool call emits nothing
// until it finishes — so a page load that takes twenty seconds used to look like a dead
// turn. These two helpers are what the chat says instead: a readable name for the card,
// and a line while the call is running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolLabel, browserLine } from '../web/transcript.js';

test('a browser tool is named in the operator’s words', () => {
  assert.equal(toolLabel({ name: 'synapse-browser_open' }), 'SynaBrowse · Open');
  assert.equal(toolLabel({ name: 'synapse-browser_read' }), 'SynaBrowse · Read');
  assert.equal(toolLabel({ name: 'synapse-browser_handoff' }), 'SynaBrowse · Handoff');
  assert.equal(toolLabel({ name: 'synapse-browser.screenshot' }), 'SynaBrowse · Screenshot');
  // An unknown browser tool still says whose it is; another tool is left alone.
  assert.equal(toolLabel({ name: 'synapse-browser_teleport' }), 'SynaBrowse');
  assert.equal(toolLabel({ name: 'shell' }), 'shell');
  assert.equal(toolLabel({}), 'tool');
});

test('a running browser call says what it is doing', () => {
  assert.equal(browserLine({ url: 'https://www.example.test/a/b?c=1' }), 'SynaBrowse is opening example.test…');
  assert.equal(browserLine({ links: 20, maxChars: 8000 }), 'SynaBrowse is reading the page…');
  assert.equal(browserLine({ text: 'Sign in' }), 'SynaBrowse is clicking “Sign in”…');
  assert.equal(browserLine({ selector: '#submit' }), 'SynaBrowse is clicking #submit…');
  assert.equal(browserLine({ full: true }), 'SynaBrowse is taking a picture…');
  assert.equal(browserLine({ ms: 1200 }), 'SynaBrowse is watching the page…');
  assert.equal(browserLine({ host: 'example.test' }), 'SynaBrowse is waiting for you…');
  assert.equal(browserLine({ url: 'https://example.test/', what: 'sign in to example.test' }), 'SynaBrowse is asking you to sign in…');
});

test('a call that is not the browser is not given a browser line', () => {
  assert.equal(browserLine({ command: 'ls -la' }), '');
  assert.equal(browserLine({ filePath: 'a.txt' }), '');
  assert.equal(browserLine(null), '');
  assert.equal(browserLine({ url: 'not a url' }), 'SynaBrowse is opening a page…', 'a bad address still says what is happening');
});
