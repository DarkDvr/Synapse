// The rail's dots and the Private toggle (15 Nov).
//
// The operator: the green circles on finished projects "have no reason to be there", and
// amber for working is redundant because the row is already animated. Red stays — a
// stalled upstream is the one thing nothing else shows. And the project menu gained a
// Private switch below Cmd, after a divider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel) => fs.readFileSync(path.resolve(rel), 'utf8');

test('the rail draws one dot: the red one for a stalled session', () => {
  const js = read('web/projects.js');
  assert.match(js, /chat && isStalled\(chat\.id\) \? liveDot\(chat\.id, \{ clickable: false \}\) : ''/);
  assert.doesNotMatch(js, /ok: used/, 'no green state is asked for');
  assert.doesNotMatch(js, /idle: /, 'no grey state is asked for');
  assert.doesNotMatch(js, /on: working/, 'no amber state is asked for');
  const css = read('web/synapse.css');
  assert.doesNotMatch(css, /\.tree-live\.ok/, 'the green rule is gone');
  assert.doesNotMatch(css, /\.tree-live\.idle/, 'the grey rule is gone');
  const live = /\.tree-live \{([\s\S]*?)\}/.exec(css);
  assert.ok(live, 'the dot still has a rule');
  assert.match(live[1], /background: var\(--red\)/, 'and the one left is red');
});

test('every project row is translucent, and lighter-handed than the chosen one', () => {
  const css = read('web/synapse.css');
  const base = /\.tree-row\.project \{([\s\S]*?)\}/.exec(css);
  assert.ok(base, 'the project row has a base rule');
  assert.match(base[1], /background: rgba\(255, 255, 255, 0\.04\)/, 'a translucent panel, not an opaque card');
  assert.match(base[1], /border: 1px solid rgba\(255, 255, 255, 0\.07\)/, 'and a translucent edge');
  // The green "you are here" wash is heavier (8%) than the neutral base (4%), which is
  // what makes the chosen row the one that stands out.
  const current = /\.tree-row\.project\.is-current \{([\s\S]*?)\}/.exec(css);
  assert.ok(current, 'the chosen row has a rule');
  assert.match(current[1], /rgba\(53, 192, 138, 0\.08\)/);
});

test('a private project wears a quiet violet tint in the rail', () => {
  const js = read('web/projects.js');
  assert.match(js, /\$\{p\.private \? ' is-private' : ''\}/, 'the row knows it is private');
  assert.match(js, /p\.private \? ' · private' : ''/, 'and the tooltip says so');
  const css = read('web/synapse.css');
  const rule = /\.tree-row\.project\.is-private \{([\s\S]*?)\}/.exec(css);
  assert.ok(rule, 'the private row has a rule');
  assert.match(rule[1], /background: rgba\(124, 108, 255, 0\.07\)/, 'a wash, not a fill');
  assert.match(rule[1], /border-color: rgba\(124, 108, 255, 0\.30\)/, 'and a quiet edge');
  // "You are here" and "it is working" are momentary and must win over a property.
  const current = css.indexOf('.tree-row.project.is-current {');
  const priv = css.indexOf('.tree-row.project.is-private {');
  assert.ok(current > priv, 'the private rule comes before the current-project rules');
});

test('the project menu has a Private toggle below Cmd', () => {
  const js = read('web/project-menu.js');
  const from = js.indexOf('el.innerHTML = `');
  const menu = js.slice(from, js.indexOf('el.querySelector', from));
  const order = [
    'data-menu-action="browse"',
    'data-menu-action="cmd"',
    'project-menu-sep',
    'data-menu-action="private"',
    'data-menu-action="up"',
  ];
  let at = -1;
  for (const needle of order) {
    const next = menu.indexOf(needle, at + 1);
    assert.ok(next > at, `${needle} comes in this order`);
    at = next;
  }
  assert.match(menu, /role="menuitemcheckbox"/, 'it is a toggle, not an ordinary action');
  assert.match(menu, /aria-checked="\$\{p\.private \? 'true' : 'false'\}"/, 'and it says whether it is on');
  assert.match(js, /async function toggleProjectPrivate/, 'the toggle saves');
  assert.match(js, /\/private`, \{ private: !p\.private \}/, 'through the project route');
  const css = read('web/synapse.css');
  assert.match(css, /\.project-menu-item\.is-toggle/, 'the row is laid out for a label and a mark');
  assert.match(css, /\.project-menu-mark/, 'and the mark has a style');
});
