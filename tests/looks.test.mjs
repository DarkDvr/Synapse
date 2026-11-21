// The look: one picture, one surface, two numbers — and a way back to no picture.
//
// The rules that matter are the clamping (a config file is an editable document, and a
// hand-edited number must not make the chat see-through) and the fact that the
// conversation, the role cards and the plan are drawn as *one* surface: the operator
// asked for them to match, and three rules drifting apart is how they stop matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  GROUNDS,
  PANEL_OPACITY_DEFAULT,
  PANEL_OPACITY_MIN,
  PANEL_OPACITY_MAX,
  GROUND_STRENGTH_DEFAULT,
  GROUND_STRENGTH_MIN,
  GROUND_STRENGTH_MAX,
  panelOpacity,
  groundStrength,
} from '../web/ui-prefs.js';
import { DEFAULTS, normalize } from '../src/config.js';

const css = fs.readFileSync(path.join(process.cwd(), 'web', 'synapse.css'), 'utf8');

test('the two numbers are clamped, and a missing one is the default', () => {
  assert.equal(panelOpacity(PANEL_OPACITY_DEFAULT), PANEL_OPACITY_DEFAULT);
  assert.equal(panelOpacity(''), PANEL_OPACITY_DEFAULT, 'an unset setting is not the minimum');
  assert.equal(panelOpacity(undefined), PANEL_OPACITY_DEFAULT);
  assert.equal(panelOpacity(10), PANEL_OPACITY_MIN, 'below the floor the prose sits on the picture');
  assert.equal(panelOpacity(200), PANEL_OPACITY_MAX);
  assert.equal(panelOpacity(84), 84);

  assert.equal(groundStrength(GROUND_STRENGTH_DEFAULT), GROUND_STRENGTH_DEFAULT);
  assert.equal(groundStrength(''), GROUND_STRENGTH_DEFAULT);
  assert.equal(groundStrength(0), GROUND_STRENGTH_MIN, 'the picture is never switched off by a number');
  assert.equal(groundStrength(500), GROUND_STRENGTH_MAX);
});

test('the three pictures are named in one place, and none is a choice', () => {
  assert.deepEqual(GROUNDS.map((g) => g.v), ['nebula', 'neural', 'none']);
  assert.ok(GROUNDS.every((g) => g.l && g.v), 'every picture has a label and a value');
});

test('the config carries the look, and a hand-edited one is brought back into range', () => {
  assert.equal(DEFAULTS.ui.background, 'nebula');
  assert.equal(DEFAULTS.ui.panelOpacity, PANEL_OPACITY_DEFAULT);
  assert.equal(DEFAULTS.ui.backgroundStrength, GROUND_STRENGTH_DEFAULT);

  const bad = normalize({ ui: { background: 'purple', panelOpacity: 10, backgroundStrength: 999 } });
  assert.equal(bad.ui.background, 'nebula', 'an unknown picture falls back rather than leaving the page blank');
  assert.equal(bad.ui.panelOpacity, PANEL_OPACITY_MIN);
  assert.equal(bad.ui.backgroundStrength, GROUND_STRENGTH_MAX);

  const kept = normalize({ ui: { background: 'none', panelOpacity: 88, backgroundStrength: 40 } });
  assert.equal(kept.ui.background, 'none');
  assert.equal(kept.ui.panelOpacity, 88);
  assert.equal(kept.ui.backgroundStrength, 40);
});

test('the conversation, the cards and the plan are one surface', () => {
  // One rule, three selectors: a fill written once is a fill that cannot drift.
  const shared = /\.chat-dock,\s*\.role-card,\s*\.rail-panel\s*\{\s*background:\s*rgba\(11,\s*13,\s*18,\s*var\(--panel-alpha\)\)/;
  assert.match(css, shared, 'the three panels no longer share one surface');
  assert.doesNotMatch(
    css,
    /\.chat-scroll\s*\{[^}]*background:/,
    'the transcript has a fill of its own again, so it cannot match the cards',
  );
  assert.match(css, /--panel-alpha:\s*0\.94/, 'the default surface is missing');
  assert.match(css, /--ground-strength:\s*0\.66/, 'the default ground is missing');
});

test('the rail has its own picture, and none means none anywhere', () => {
  assert.match(css, /body\.dark \.sidebar \{[\s\S]*?url\("\/assets\/bg-left\.jpg"\)/, 'the rail lost its picture');
  assert.ok(!fs.existsSync(path.join(process.cwd(), 'web', 'assets', 'bg-left2.png')), 'the old rail picture is still shipped');
  assert.match(css, /body\[data-ground="none"\] \.control-room \.main-content \{ background: #0e161e/, 'none does not restore the stage');
  assert.match(css, /body\[data-ground="none"\] \.sidebar \{ background-image: none/, 'none leaves the rail picture up');
});
