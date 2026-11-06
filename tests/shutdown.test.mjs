// Turning the PC off when the Architect finishes.
//
// This is the one feature that can take the machine away, so the tests are about the
// ways it must *not* happen: a route nobody enabled, a request without a confirm, a
// run still in flight, a cancel that arrives in time, and a stop or a failure never
// arming it at all. The clock is the server's (a hidden window's timers are throttled
// by the browser), so the timers are driven here with node's mock clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../src/api.js';
import { normalize, DEFAULTS } from '../src/config.js';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
// The page is several modules now (app.js plus the ones that left it), so "the page
// says" reads them all: a move must not read as a deletion.
const ui = () => ['web/app.js', 'web/settings-panes.js', 'web/settings-form.js', 'web/ui-prefs.js'].map(read).join('\n');

function harness({ config = {}, live = [] } = {}) {
  const events = [];
  let offs = 0;
  const api = createApi({
    getConfig: () => config,
    applyConfig: async () => {},
    engine: {},
    logger: { channel: () => ({ info() {}, debug() {}, warn() {}, error() {} }) },
    getBootError: () => null,
    projects: {},
    toolStats: null,
    probe: null,
    modelCache: null,
    inspectModel: null,
    probeDir: null,
    runs: { active: () => live },
    engineUpdate: null,
    synapseUpdate: null,
    restart: null,
    stopSelf: null,
    pcShutdown: () => { offs += 1; return { ok: true }; },
    notify: (ev) => events.push(ev),
    permissionLog: null,
    permissionGate: null,
    permissionMemory: null,
  });
  return { api, events, offs: () => offs };
}

const SHUTDOWN_ON = { shutdown: { whenDone: true, minutes: 5 } };

test('the shutdown settings are off by default and clamped', () => {
  assert.equal(DEFAULTS.shutdown.whenDone, false, 'a fresh install must never power the machine off');
  assert.equal(normalize({}).shutdown.whenDone, false);
  assert.equal(normalize({ shutdown: { whenDone: 'yes' } }).shutdown.whenDone, false, 'only a real true arms it');
  assert.equal(normalize({ shutdown: { whenDone: true } }).shutdown.whenDone, true);
  assert.equal(normalize({ shutdown: { minutes: 0 } }).shutdown.minutes, 1);
  assert.equal(normalize({ shutdown: { minutes: 900 } }).shutdown.minutes, 180);
  assert.equal(normalize({ shutdown: { minutes: 'nope' } }).shutdown.minutes, DEFAULTS.shutdown.minutes);
  assert.equal(normalize({ shutdown: { minutes: 12 } }).shutdown.minutes, 12);
});

test('the language list is English until a translation exists', () => {
  assert.equal(normalize({}).ui.language, 'en');
  assert.equal(normalize({ ui: { language: 'ru' } }).ui.language, 'en', 'a language with no strings falls back');
  assert.equal(normalize({ ui: { language: 'EN' } }).ui.language, 'en');
});

test('power-off is refused unless the setting is on', async () => {
  const { api, offs } = harness({ config: { shutdown: { whenDone: false, minutes: 5 } } });
  const res = await api.powerOff({ confirm: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /off in Settings/);
  assert.equal(offs(), 0, 'the machine was never asked to go off');
});

test('power-off needs the countdown to confirm, not just a call', async () => {
  const { api, offs } = harness({ config: SHUTDOWN_ON });
  assert.equal((await api.powerOff({})).ok, false);
  assert.equal((await api.powerOff({ confirm: 'yes' })).ok, false, 'a string is not a confirmation');
  assert.equal(offs(), 0);
});

test('power-off refuses while a run is live, so the work is not lost', async () => {
  const { api, offs } = harness({ config: SHUTDOWN_ON, live: [{ task: 't5b1' }] });
  const res = await api.powerOff({ confirm: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /still going/);
  assert.equal(offs(), 0);
});

test('arming is refused when the setting is off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { api, events } = harness({ config: { shutdown: { whenDone: false, minutes: 5 } } });
  const res = await api.armPowerOff({ minutes: 1 });
  assert.equal(res.ok, false);
  t.mock.timers.tick(10 * 60_000);
  assert.deepEqual(events, [], 'nothing was ever scheduled');
});

test('the server waits the minutes, warns for twenty seconds, then turns the PC off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { api, events, offs } = harness({ config: SHUTDOWN_ON });

  const armed = await api.armPowerOff({ minutes: 5 });
  assert.equal(armed.ok, true);

  t.mock.timers.tick(5 * 60_000 - 1);
  assert.deepEqual(events, [], 'nothing happens before the minute you typed is up');

  t.mock.timers.tick(1);
  assert.deepEqual(events.at(-1), { kind: 'shutdown-warning', seconds: 20 }, 'the warning starts at 20');

  t.mock.timers.tick(19_000);
  assert.equal(offs(), 0, 'nothing goes off during the countdown');
  assert.equal(events.at(-1).kind, 'shutdown-tick');
  assert.equal(events.at(-1).seconds, 1, 'the last number shown is 1');

  t.mock.timers.tick(1000);
  assert.equal(offs(), 1, 'at zero the machine goes off, once');
  assert.equal(events.at(-1).kind, 'shutdown-done');

  // The count is over: nothing else may fire, however long the test runs on.
  t.mock.timers.tick(600_000);
  assert.equal(offs(), 1);
});

test('cancelling during the wait leaves the machine on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { api, events, offs } = harness({ config: SHUTDOWN_ON });
  await api.armPowerOff({ minutes: 1 });
  t.mock.timers.tick(30_000);
  const res = await api.cancelPowerOff();
  assert.equal(res.cancelled, true);
  assert.deepEqual(events.at(-1), { kind: 'shutdown-cancelled' });
  t.mock.timers.tick(10 * 60_000);
  assert.equal(offs(), 0, 'the wait was really cleared, not just hidden');
});

test('cancelling during the countdown stops it too', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { api, events, offs } = harness({ config: SHUTDOWN_ON });
  await api.armPowerOff({ minutes: 1 });
  t.mock.timers.tick(60_000);
  assert.equal(events.at(-1).kind, 'shutdown-warning');
  t.mock.timers.tick(5_000);
  assert.equal((await api.cancelPowerOff()).cancelled, true);
  t.mock.timers.tick(60_000);
  assert.equal(offs(), 0, 'the countdown was cleared, not left running');
});

test('Auto-Shutdown fires with the legacy whenDone switch off', async (t) => {
  // The project's Auto-Shutdown switch is the one the operator sees; `whenDone` is
  // the old global switch and is no longer in Settings. The countdown used to clear
  // its own "armed by automation" flag before the final check, so it refused itself
  // every twenty minutes all night (4 Nov).
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { api, events, offs } = harness({ config: { shutdown: { whenDone: false, minutes: 5 } } });
  const armed = await api.armPowerCountdown();
  assert.equal(armed.ok, true);
  t.mock.timers.tick(20_000);
  assert.equal(offs(), 1, 'the automation countdown turned the PC off');
  assert.equal(events.at(-1).kind, 'shutdown-done');
});

test('a run starting during the countdown saves the machine', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const live = [];
  const { api, events, offs } = harness({ config: SHUTDOWN_ON, live });
  await api.armPowerOff({ minutes: 1 });
  t.mock.timers.tick(60_000);
  live.push({ task: 't6' }); // the operator sent something, or a worker woke up
  t.mock.timers.tick(1000);
  assert.equal(offs(), 0);
  assert.equal(events.at(-1).kind, 'shutdown-cancelled');
  t.mock.timers.tick(120_000);
  assert.equal(offs(), 0);
});

test('the routes exist and are not the server stop', () => {
  const server = read('src/server.js');
  // `/api/shutdown` stops the server and leaves the machine on. The PC action needs
  // its own door, or "stop the server" would turn the computer off.
  assert.match(server, /seg\[0\] === 'power-off' && seg\.length === 1 && method === 'POST'/);
  assert.match(server, /seg\[1\] === 'arm' && method === 'POST'/);
  assert.match(server, /seg\[1\] === 'cancel' && method === 'POST'/);
  const api = read('src/api.js');
  assert.match(api, /shutdown: async \(\) =>[^]*?stopSelf\(\)/, 'the server stop still stops the server');
  assert.match(api, /const POWER_COUNTDOWN_SEC = 20/);
});

test('the page draws the countdown the server sends, and every way out cancels', () => {
  const app = read('web/app.js');
  // The page no longer arms: Auto-Shutdown's clock is the server's (src/auto-shutdown.js).
  assert.match(app, /api\('POST', '\/api\/power-off\/cancel'\)/);
  assert.match(app, /ev\.kind === 'shutdown-warning'/);
  assert.match(app, /ev\.kind === 'shutdown-tick'/);
  // The overlay's only exit is cancel: no close button, no timer that dismisses
  // itself, no click-through.
  const html = read('web/index.html');
  const block = /<div class="modal-backdrop" id="shutdownModal"[\s\S]*?<\/div>\s*<\/div>/.exec(html);
  assert.ok(block, 'the overlay is in the shell');
  assert.match(block[0], /id="cancelShutdown"/);
  assert.doesNotMatch(block[0], /close-x/, 'a dismiss-and-shut-down button would be the bug');
  assert.match(app, /if \(e\.key === 'Escape' && !\$\('shutdownModal'\)\.hidden\)/);
  assert.match(app, /e\.target === \$\('shutdownModal'\)/, 'a click outside cancels too');
});

test('a stop or a failure never arms the shutdown', () => {
  // Auto-Shutdown is armed by the server (src/auto-shutdown.js), which only counts
  // after the whole machine is quiet — no turn, no question, no permission. The
  // page can no longer arm it at all, which is the strongest form of "a stop never
  // does": there is nothing on the page to forget.
  const app = read('web/app.js');
  assert.doesNotMatch(app, /power-off\/arm/, 'the page does not arm the wait any more');
  assert.match(app, /if \(live\) \{[^]*?cancelShutdown\(\);/, 'new work still cancels the countdown');
  assert.match(read('src/auto-shutdown.js'), /live === 0 && \(forms \|\| \[\]\)\.length === 0/);
});

test('Automation holds the four delays, and the old shutdown switch is gone', () => {
  const app = ui();
  for (const path of [
    'automation.keepBuildingSec',
    'automation.permissionsSec',
    'automation.answerSec',
    'automation.shutdownMin',
  ]) {
    assert.ok(app.includes(`'${path}'`), `${path} is in Settings`);
  }
  // The old global switch and its minutes are replaced by the per-project
  // Auto-Shutdown, which reads the delay above.
  assert.doesNotMatch(app, /'shutdown\.whenDone'/);
  assert.doesNotMatch(app, /'shutdown\.minutes'/);
  assert.match(app, /'ui\.language'/);
  // One option, and it is English: a selector with an entry that does nothing would
  // be the kind of mock this project forbids.
  assert.match(app, /const LANGUAGES = \[\{ v: 'en', l: 'English' \}\]/);
});

// The warning's subtitle lost its centring to the locked baseline: summit.css ships
// `.modal p { margin:0; font-size:12px; line-height:1.7 }`, which outranks a plain
// `.shutdown-lead` and left the paragraph at the left of its box with its text
// centred inside it — the operator saw it and called it off-centre. Measured before:
// box 365..735 in a content area of 364..916. The rule has to be scoped to the
// dialog, and the spacing has to be stated there too.
test('the shutdown subtitle is scoped past the baseline modal rule, and centred', () => {
  const css = read('web/synapse.css');
  const rule = /\.shutdown-modal \.shutdown-lead\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the subtitle rule is scoped to the dialog');
  assert.match(rule[1], /align-self:\s*center/, 'centred as a flex item, not by its margins alone');
  assert.match(rule[1], /text-align:\s*center/);
  assert.match(rule[1], /margin:\s*16px auto 22px/, 'breathing room above and below');
  assert.doesNotMatch(css, /^\.shutdown-lead\s*\{/m, 'an unscoped rule loses to `.modal p` and reads off-centre');
});
