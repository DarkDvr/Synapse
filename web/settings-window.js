// The Settings window: its tabs, its draft, and the one button that saves.
//
// Every pane renders from a *draft* (state.setDraft), never from the saved file.
// Leaving a tab collects its fields into the draft first, so a half-typed port
// survives a look at Providers, and Revert is then exactly "throw the draft away".
// Nothing reaches disk until Apply.
//
// The window is also the one place two people cannot be at once: the server owns the
// lock, and this asks for it on open and gives it back on close.
//
// Eight things come from app.js and are wired at boot: the four update actions, the
// model reload, the skills read, the dialog, the LLM status line and the chime's
// preview sound.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { readPath, writePath, parseModelLines, slugify } from './settings-data.js';
import { samePath } from './format.js';
import { SETTINGS_TABS, PANES } from './settings-panes.js';
import { settingsProviders, providersWiring, providerAt, moveProvider, addProvider, removeProvider, selectProvider, refreshProviderModels } from './providers.js';
import { setIcon } from './icons.js';
import { modelByRef, topEfforts } from './run-view.js';
import { renderKeep } from './run-menu.js';
import { renderToolUsage } from './tool-panels.js';
import { schedulePermissionRender } from './pending.js';
import { applyChatText, applyLanguage } from './ui-prefs.js';

const missing = (name) => () => {
  throw new Error(`settings-window.js: ${name} was not wired at boot`);
};
const wired = {
  applyEngineUpdate: missing('applyEngineUpdate'),
  applySynapseUpdate: missing('applySynapseUpdate'),
  checkSkills: missing('checkSkills'),
  checkUpdates: missing('checkUpdates'),
  loadModels: missing('loadModels'),
  openDialog: missing('openDialog'),
  playDoneSound: missing('playDoneSound'),
  renderLlmStatus: missing('renderLlmStatus'),
};

/** Hand this module the eight things that live in app.js. Called once, at boot. */
export function settingsWindowWiring(fns) {
  Object.assign(wired, fns);
}

// ── Prohibited: the list's four handlers ────────────────────────
// The pane is in ./settings-panes.js; these edit the draft and re-render the window,
// which is this file's state machine. The PROHIBITED tier itself is the server's
// (src/protection.js): a built-in can be switched off but never deleted.

export async function loadProtection() {
  try {
    state.protection = await api('GET', '/api/protection');
  } catch { /* the pane shows what it already knows */ }
  return state.protection;
}

export function toggleProtection(input) {
  const c = collectSettings();
  if (!c) return;
  c.protection = c.protection || {};
  const kind = input.dataset.protKind;
  const target = input.dataset.protWrite || input.dataset.protRead;
  const isWrite = input.hasAttribute('data-prot-write');
  if (kind === 'builtin') {
    // The two id lists store the *refusals*: a built-in id sits in builtinsOff when
    // its Write is cleared, and in builtinsSealed when its Read is cleared.
    const key = isWrite ? 'builtinsOff' : 'builtinsSealed';
    const set = new Set((c.protection[key] || []).map(String));
    if (isWrite) {
      // Ticked = changes allowed = the id is listed in builtinsOff.
      if (input.checked) set.add(target);
      else set.delete(target);
    } else if (input.checked) set.delete(target);
    else set.add(target);
    c.protection[key] = [...set];
  } else {
    const entry = (c.protection.paths || []).find((p) => samePath(p.path, target));
    if (entry) {
      if (isWrite) entry.write = input.checked;
      else entry.read = input.checked;
    }
  }
  renderSettings();
}

export function removeProtectionPath(target) {
  if (!target) return;
  const c = collectSettings();
  if (!c) return;
  c.protection = c.protection || {};
  c.protection.paths = (c.protection.paths || []).filter((p) => !samePath(p.path, target));
  // Remembered, so the boot seed for a browser folder does not put it back.
  c.protection.removed = [...new Set([...(c.protection.removed || []), target])];
  renderSettings();
}

export async function addProtectionPath(kind) {
  try {
    const picked = await api('POST', '/api/protection/pick', { kind: kind === 'file' ? 'file' : 'folder' });
    const chosen = String(picked?.path || '').trim();
    if (!chosen) return;
    const c = collectSettings();
    if (!c) return;
    c.protection = c.protection || {};
    const paths = Array.isArray(c.protection.paths) ? c.protection.paths : (c.protection.paths = []);
    if (!paths.some((p) => samePath(p.path, chosen))) {
      // A new path starts protected for writes and readable, the same default the
      // built-ins have; the operator clears Read only when touching it is dangerous.
      paths.push({ path: chosen, label: '', write: false, read: true });
    }
    c.protection.removed = (c.protection.removed || []).filter((p) => !samePath(p, chosen));
    renderSettings();
  } catch (err) {
    toast('Could Not Add A Path', err.message);
  }
}

// The nine panes come from ./settings-panes.js; Providers is the one editor that
// needs this file's own state machine, so it is added here.
export const SETTINGS_PANES = { ...PANES, providers: settingsProviders };

export function renderSettingsTabs() {
  const nav = $('settingsTabs');
  if (!nav) return;
  nav.innerHTML = SETTINGS_TABS.map(
    (t) =>
      `<button type="button" class="set-tab${t.id === state.settingsTab ? ' is-active' : ''}" role="tab" ` +
      `aria-selected="${t.id === state.settingsTab}" data-set-tab="${t.id}">${setIcon(t.icon)}<span>${t.label}</span></button>`,
  ).join('');
}

export function renderSettings({ scrollTop } = {}) {
  const c = state.setDraft;
  if (!c) {
    $('settingsBody').innerHTML = '<p class="rail-note">Config unavailable.</p>';
    $('settingsTabs').innerHTML = '';
    return;
  }
  if (!SETTINGS_PANES[state.settingsTab]) state.settingsTab = 'general';
  const body = $('settingsBody');
  // Keep the pane where it was. Every edit re-renders this markup — a Refresh
  // List, an eye toggle, a provider picked — and jumping to the top after each
  // one loses the operator's place, which is worst for the button they just
  // pressed. Only a tab switch or opening the window starts at the top.
  const keep = scrollTop === undefined ? body.scrollTop : scrollTop;
  renderSettingsTabs();
  body.innerHTML = SETTINGS_PANES[state.settingsTab](c);
  body.scrollTop = keep;
  updateSettingsFoot();
}

/**
 * The footer's one truth: does the form differ from the saved config, and does
 * what differs only take effect on a restart?
 *
 * Left: Cancel and Revert, the two ways to throw the draft away. Right: Apply —
 * green, and disabled when there is nothing to apply or when only a restart can
 * apply it — and one primary whose label says what pressing it does: Close, Save
 * & Close, or Save & Restart. The colours are the meaning: green adds, red
 * discards.
 */
export function updateSettingsFoot() {
  const foot = document.querySelector('.set-foot');
  if (!foot) return;
  // About is the one page that keeps its own Close button inside the card: it is a
  // credits page, not a form. Every other tab — Updates included — wears the same
  // footer, because a page that is missing the buttons the window always has reads
  // as a different window. On a page with nothing to save they sit in their resting
  // state: Cancel and Revert are grey-red and disabled, Apply is disabled, Close is
  // Close.
  foot.hidden = state.settingsTab === 'about';
  if (foot.hidden || !state.setDraft || !state.config) return;
  collectSettings();
  const dirty = JSON.stringify(state.setDraft) !== JSON.stringify(state.config);
  const needsRestart = dirty && restartNeeded(state.config, state.setDraft);
  const busy = Boolean(state.updateBusy);
  const apply = $('applySettings');
  if (apply) apply.disabled = !dirty || needsRestart || busy;
  // Cancel has nothing to throw away until the form differs from the file; a red
  // button that only closes is a promise the window cannot keep.
  const cancel = $('cancelSettings');
  if (cancel) cancel.disabled = !dirty || busy;
  // Revert is the same promise: with nothing typed there is nothing to put back.
  const revert = $('revertSettings');
  if (revert) revert.disabled = !dirty || busy;
  const primary = $('settingsPrimary');
  if (!primary) return;
  primary.disabled = busy;
  primary.textContent = dirty ? (needsRestart ? 'Save & Restart' : 'Save & Close') : 'Close';
  primary.dataset.action = dirty ? (needsRestart ? 'save-restart' : 'save-close') : 'close';
  primary.className =
    'btn btn-sm' +
    (dirty ? (needsRestart ? ' btn-outline-red' : ' btn-green-solid') : ' btn-secondary');
}

/** The visible pane's controls into the draft. Called before switching tabs and
 *  before saving, so nothing typed is lost by looking at something else. */
export function collectSettings() {
  const c = state.setDraft;
  if (!c) return null;
  for (const el of $('settingsBody').querySelectorAll('[data-path]')) {
    const path = el.dataset.path;
    let value = el.type === 'checkbox' ? el.checked : el.value;
    // A slider hands back a string like a text box; it is a number like the box it
    // replaced, so the two are collected the same way.
    if (el.type === 'number' || el.type === 'range') value = Number(value);
    if (el.type === 'number' && !Number.isFinite(value)) continue;
    // A field shown in seconds or minutes but stored in the base unit: the
    // conversion belongs with the setting, not in the operator's head.
    if (el.dataset.scale) value = Math.round(value * Number(el.dataset.scale));
    // A folder list is one line in the form and an array in the config.
    if (path === 'engine.opencode.skillPaths') {
      writePath(c, path, String(value).split(';').map((p) => p.trim()).filter(Boolean));
      continue;
    }
    // The ladder is a comma list in the form and an array in the config.
    if (path === 'worker.ladder') {
      writePath(c, path, String(value).split(',').map((r) => r.trim()).filter(Boolean));
      continue;
    }
    // SynaBrowse's allowlist is one host per line in the form, an array in the config.
    if (path === 'browser.allow') {
      writePath(
        c,
        path,
        String(value).split(/[\n,;]+/).map((h) => h.trim()).filter(Boolean),
      );
      continue;
    }
    writePath(c, path, value);
  }
  return c;
}

export function switchSettingsTab(id) {
  if (id === state.settingsTab) {
    if (id === 'updates') wired.checkUpdates();
    return;
  }
  collectSettings();
  state.settingsTab = id;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  renderSettings({ scrollTop: 0 });
  // Opening the Updates page is the operator asking, like opening the chip's
  // popup: check both feeds now rather than showing a stale answer.
  if (id === 'updates') wired.checkUpdates();
  // The prohibited list is the server's (built-ins live in code), so the tab
  // reads it once. The draft's ticks survive the re-render.
  if (id === 'prohibited' && !state.protection) {
    loadProtection().then(() => {
      if (state.settingsTab === 'prohibited') renderSettings();
    });
  }
}

// The editor's fields write straight into the selected draft provider: there is
// no data-path for them because a provider is an object in a list, not a path.
export function onSettingsInput(e) {
  // The chat's size is the one setting whose effect is worth seeing while it is
  // being chosen: a number in a box says nothing about whether a full answer still
  // fits above the composer. The draft is not touched — Save is still the write.
  // The slider's own readout follows the thumb, so the number and the size are never
  // a step apart (10 Nov).
  if (e.target?.dataset?.path === 'ui.chatTextPx') {
    applyChatText(e.target.value);
    // The filled part of the track follows the thumb, so the bar and the number are
    // the same answer.
    const min = Number(e.target.min);
    const max = Number(e.target.max);
    e.target.style.setProperty('--fill', `${((Number(e.target.value) - min) / (max - min || 1)) * 100}%`);
    const says = $('settingsBody')?.querySelector('[data-says="ui.chatTextPx"]');
    if (says) says.textContent = `${e.target.value} px`;
    return;
  }
  const el = e.target.closest('[data-prov]');
  if (!el) return;
  const p = providerAt(state.setProvSelected);
  if (!p) return;
  const field = el.dataset.prov;
  if (field === 'models') { p.models = parseModelLines(el.value, p.models); return; }
  if (field === 'apiKey') {
    p.apiKey = el.value;
    p.apiKeyRemoved = false;
    el.dataset.masked = '0';
    return;
  }
  if (field === 'type') {
    // Three choices, two behaviours: llama.cpp is a local server that answers
    // `/props` instead of LM Studio's list endpoint.
    p.type = el.value === 'llamacpp' ? 'llamacpp' : el.value === 'local' ? 'local' : 'openai';
    if (p.type !== 'local') p.format = 'openai';
    renderSettings();
    return;
  }
  p[field] = el.value;
  // A hand-typed key is no longer the mask, and the hint under the field says so
  // — but re-rendering on every keystroke would take the caret with it.
  if (field === 'id') {
    // The prefix is the word before the slash in every model name this provider
    // serves, so it is slugged as it is typed. Typing one stops it following the
    // name: the operator has said what they want.
    p.id = slugify(el.value);
    p.idTouched = true;
    el.value = p.id;
    return;
  }
  if (field === 'name') {
    const row = $('settingsBody').querySelector(`[data-prov-row="${state.setProvSelected}"] .prov-name`);
    if (row) row.textContent = el.value.trim() || 'Untitled provider';
    // A new provider's prefix follows its name until it is typed by hand.
    if (p.idTouched === false) {
      p.id = slugify(el.value);
      const prefix = $('settingsBody').querySelector('[data-prov="id"]');
      if (prefix) prefix.value = p.id;
    }
  }
}

export async function onSettingsClick(e) {
  if (e.target.closest('[data-close-about]')) { closeSettings(); return; }
  if (e.target.closest('[data-check-updates]')) { wired.checkUpdates(); return; }
  if (e.target.closest('#browserSignin')) {
    // SynaBrowse's sign-in is the one control in Settings that acts now rather than at
    // Save: the browser is opened on that URL and put on the second monitor's taskbar,
    // minimized, without taking focus. The session is the browser's, not this form's.
    const field = $('settingsBody')?.querySelector('#browserSigninUrl');
    const url = String(field?.value || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      toast('Sign In', 'Type the site to sign in to first — for example https://example.com/.');
      return;
    }
    const button = e.target.closest('#browserSignin');
    button.disabled = true;
    button.textContent = 'Opening…';
    try {
      const answer = await api('POST', '/api/browser/signin', { url });
      if (answer?.ok) {
        toast('SynaBrowse Is Waiting', 'It is on the second monitor’s taskbar — sign in, then close it or leave it.');
      } else {
        toast('Could Not Open SynaBrowse', answer?.error || 'The browser did not start.');
      }
    } catch (err) {
      toast('Could Not Open SynaBrowse', err.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Sign In…';
    }
    return;
  }
  if (e.target.closest('[data-test-sound]')) {
    // The pane renders from a draft; the select itself is the live choice.
    const sel = $('settingsBody')?.querySelector('select[data-path="notify.doneSound"]');
    wired.playDoneSound(sel ? sel.value : state.config?.notify?.doneSound);
    return;
  }
  const upd = e.target.closest('[data-update]');
  if (upd) {
    if (upd.disabled || state.updateBusy) return;
    if (upd.dataset.update === 'engine') wired.applyEngineUpdate();
    if (upd.dataset.update === 'synapse') wired.applySynapseUpdate();
    return;
  }
  // The Engine pane's own button now lands on the Updates page instead of
  // opening the chip's popup over the settings window.
  if (e.target.closest('[data-check-update]')) { switchSettingsTab('updates'); return; }
  // Prohibited: the tick and the two add buttons. A tick is a draft change, saved
  // with the rest of the settings; nothing is enforced until Save.
  if (e.target.closest('[data-prot-add]')) {
    const menu = $('protAddMenu');
    if (menu) menu.hidden = !menu.hidden;
    return;
  }
  const protNew = e.target.closest('[data-prot-new]');
  if (protNew) { addProtectionPath(protNew.dataset.protNew); return; }
  const protDel = e.target.closest('[data-prot-del]');
  if (protDel) { removeProtectionPath(protDel.dataset.protDel); return; }
  const protToggle = e.target.closest('[data-prot-write],[data-prot-read]');
  if (protToggle) { toggleProtection(protToggle); return; }
  const add = e.target.closest('[data-prov-add]');
  if (add) {
    const menu = $('provAddMenu');
    if (menu) menu.hidden = !menu.hidden;
    return;
  }
  const newProvider = e.target.closest('[data-prov-new]');
  if (newProvider) {
    const menu = $('provAddMenu');
    if (menu) menu.hidden = true;
    addProvider(newProvider.dataset.provNew);
    return;
  }
  // The order arrows come before the row handler: a click on one is a move, not
  // a request to open the provider for editing.
  const move = e.target.closest('[data-prov-up],[data-prov-down]');
  if (move) {
    const up = move.hasAttribute('data-prov-up');
    moveProvider(up ? move.dataset.provUp : move.dataset.provDown, up ? -1 : 1);
    return;
  }
  const del = e.target.closest('[data-prov-del]');
  if (del) { await removeProvider(Number(del.dataset.provDel)); return; }
  const row = e.target.closest('[data-prov-row]');
  if (row) { selectProvider(Number(row.dataset.provRow)); return; }
  if (e.target.closest('[data-prov-eye]')) {
    if (providerAt(state.setProvSelected)) {
      state.setKeyRevealed = !state.setKeyRevealed;
      renderSettings();
      // Put the caret back at the end of the key rather than at the start.
      const field = $('settingsBody').querySelector('[data-prov="apiKey"]');
      if (field) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); }
    }
    return;
  }
  if (e.target.closest('[data-prov-remove]')) {
    const p = providerAt(state.setProvSelected);
    if (p) {
      p.apiKey = null;
      p.apiKeySet = false;
      p.apiKeyRemoved = true;
      state.setKeyRevealed = false;
      renderSettings();
    }
    return;
  }
  if (e.target.closest('[data-prov-fetch]')) {
    await refreshProviderModels(state.setProvSelected);
  }
}

export async function saveSettings({ close = false, restart = false } = {}) {
  const draft = collectSettings();
  if (!draft) return;
  // A provider row added by mistake - never named, never given a server - is
  // dropped here rather than half-registered. One that has a name and a server
  // but no models yet is kept: that is work in progress, and the engine simply
  // does not register it until it has something to serve.
  const providers = draft.engine?.opencode?.providers;
  if (Array.isArray(providers)) {
    draft.engine.opencode.providers = providers.filter(
      (p) => String(p.name || '').trim() || String(p.baseURL || '').trim(),
    );
  }
  // Two providers cannot share a model prefix: it is the word before the slash in
  // every model name they serve, so a duplicate would make one provider's models
  // unreachable and the other's ambiguous. Refused here rather than saved and
  // puzzled over later.
  {
    const seen = new Map();
    for (const p of draft.engine?.opencode?.providers || []) {
      const id = String(p.id || '').trim().toLowerCase();
      if (!id) continue;
      if (seen.has(id)) {
        toast(
          'Two Providers Share A Prefix',
          `"${seen.get(id)}" and "${p.name || p.id}" both use "${id}". Give one of them its own.`,
        );
        return;
      }
      seen.set(id, p.name || p.id);
    }
  }
  // A model change can strand a thinking effort the new model does not offer
  // (or that the chevron control cannot express). Clear it rather than let the
  // config and the button disagree.
  const effortIds = (ref) => topEfforts(modelByRef(ref)).map((v) => v.id);
  for (const entry of Object.values(draft.roles || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (!effortIds(entry.ref).includes(entry.variant)) delete entry.variant;
  }
  try {
    const needsRestart = restartNeeded(state.config, draft);
    state.config = await api('PUT', '/api/config', draft);
    // The chat's size is read from the config here, once, rather than by watching
    // for changes: this is the one place the file becomes the page's truth.
    applyChatText();
    applyLanguage();
    // The Auto-Shutdown delays are read by the server on its next sweep, so a
    // saved change needs nothing here. A save is also the moment to re-draw the
    // cog: the waits it names may have moved.
    state.setDraft = JSON.parse(JSON.stringify(state.config));
    state.setProvSelected = null;
    wired.renderLlmStatus();
    renderKeep();
    schedulePermissionRender();
    await wired.loadModels();
    // A new skills folder is worth reading before the operator closes the panel.
    await wired.checkSkills({ quiet: true });
    renderSettings();
    // The footer named the ending before it was pressed: a restart-required save
    // restarts here, an ordinary one is already live, and Close just closes.
    if (needsRestart) {
      if (restart) { await restartSynapse(); return; }
      await askRestart();
      return;
    }
    if (close) {
      closeSettings();
      toast('Settings Saved', 'The changes are in effect.');
      return;
    }
    toast('Settings Saved', 'These take effect straight away.');
  } catch (err) {
    toast('Could not save settings', err.message);
  }
}

/**
 * Which saved values only take effect when Synapse starts again. Everything else
 * — roles, worker timers, log level, the tool census flag — is read at the moment
 * it is used, so changing it is done the instant Save returns and asking for a
 * restart would be noise. These are the paths the UI badges with "Restart".
 */
export function restartNeeded(before, after) {
  const changed = (path) => JSON.stringify(readPath(before, path) ?? null) !== JSON.stringify(readPath(after, path) ?? null);
  const paths = [
    'server.host',
    'server.port',
    'engine.type',
    'engine.opencode.port',
    'engine.opencode.binary',
    'engine.opencode.home',
    'engine.opencode.password',
    'engine.opencode.startTimeoutMs',
    'engine.opencode.skillPaths',
  ];
  if (paths.some(changed)) return true;
  // Providers are one more thing the engine reads at start: adding a server,
  // editing its address, its models or its key all change what it serves.
  const shape = (c) =>
    JSON.stringify(
      (c?.engine?.opencode?.providers || []).map((p) => [
        p.id,
        p.type,
        p.format,
        p.name,
        p.baseURL,
        p.apiKey,
        p.models,
      ]),
    );
  return shape(before) !== shape(after);
}

/**
 * After a save: restart now, undo it, or leave it for the next start.
 *
 * The middle option is the one that needs explaining. "Revert All Changes"
 * writes back the config as it was when this window opened — the file, not just
 * the form — so a save that turns out to be a mistake is undone in one click
 * instead of by hand-editing JSON.
 */
export async function askRestart() {
  const choice = await wired.openDialog({
    title: 'Settings Saved',
    message:
      'The config file is written. The engine, the providers and the server port are read when Synapse ' +
      'starts, so a restart is what applies them. Changes to roles, workers and logging apply straight away.',
    confirmLabel: 'Restart Now',
    okResult: 'restart',
    extra: { label: 'Revert All Changes', result: 'revert', danger: true },
  });
  if (choice === 'restart') return restartSynapse();
  if (choice === 'revert') return revertSavedSettings();
  toast('Settings Saved', 'They apply the next time Synapse starts.');
}

/** Wait for the new process to answer, then bring this window back. */
export async function restartSynapse() {
  $('restartCurtain').hidden = false;
  $('restartState').textContent = 'Stopping Synapse…';
  try {
    await api('POST', '/api/restart');
  } catch {
    // The connection dropping is the expected answer: the server is going away.
  }
  $('restartState').textContent = 'Waiting for Synapse to come back…';
  const back = await waitForSynapse(90000);
  if (!back) {
    $('restartState').textContent =
      'Synapse did not come back by itself. Start the server from the Synapse tray icon, then reload this page.';
    $('restartCurtain').classList.add('is-stuck');
    return;
  }
  $('restartState').textContent = 'Back. Reopening…';
  // Closing is what the operator asked for; a tab that was not opened by script
  // cannot be closed, and then reloading is the useful thing instead.
  try { window.close(); } catch { /* blocked, fall through */ }
  setTimeout(() => location.reload(), 350);
}

export async function waitForSynapse(timeoutMs) {
  const started = Date.now();
  // The old process needs a moment to die; asking straight away would get the
  // answer from the server we are waiting to replace.
  await new Promise((r) => setTimeout(r, 1500));
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json();
        if (body?.engine?.endpoint) return true;
      }
    } catch { /* still down */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Put the config file (and the form) back to what this window opened with. */
export async function revertSavedSettings() {
  if (!state.settingsSnapshot) return;
  try {
    state.config = await api('PUT', '/api/config', state.settingsSnapshot);
    applyChatText();
    state.setDraft = JSON.parse(JSON.stringify(state.config));
    state.setProvSelected = null;
    state.setKeyRevealed = false;
    state.setProvFetch = null;
    wired.renderLlmStatus();
    await wired.loadModels();
    await wired.checkSkills({ quiet: true });
    renderSettings();
    toast('Changes Reverted', 'The config file is back to what it held when this window opened.');
  } catch (err) {
    toast('Could Not Revert', err.message);
  }
}

export async function resetModelAsks() {
  try {
    const r = await api('POST', '/api/models/reset-asks');
    toast('Ask Counters Reset', `${r.models} model(s) may be asked again.`);
  } catch (err) {
    toast('Could Not Reset Ask Counters', err.message);
  }
}

export async function clearToolCensus() {
  try {
    await api('POST', '/api/tools/reset');
    await renderToolUsage();
    toast('Tool Census Cleared', 'The Tools in use panel starts from zero.');
  } catch (err) {
    toast('Could Not Clear the Tool Census', err.message);
  }
}

export async function openSettings() {
  if (!state.config) { toast('Config Unavailable', 'Synapse could not read its own config file.'); return; }
  // One editor at a time. The server owns the lock; this is only its face.
  try {
    await api('POST', '/api/settings/lock', { action: 'acquire' });
    state.settingsLock = { yours: true };
  } catch (err) {
    toast('Settings Are Open Elsewhere', err.message);
    return;
  }
  // Every edit in this window happens to a copy; the file only changes on Save.
  state.setDraft = JSON.parse(JSON.stringify(state.config));
  // And this copy is what "Revert All Changes" puts back if the save was a
  // mistake — the file as it was when the window opened, not the form.
  state.settingsSnapshot = JSON.parse(JSON.stringify(state.config));
  state.settingsTab = state.settingsTab || 'general';
  state.setProvSelected = null;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  renderSettings({ scrollTop: 0 });
  $('settingsModal').hidden = false;
  // The tab is remembered across openings; if it is Updates, opening the window
  // is also a request for a fresh answer.
  if (state.settingsTab === 'updates') wired.checkUpdates();
}
export function closeSettings({ force = false } = {}) {
  // An update started from this window is visible only here; the chip's popup
  // has the same rule. Locking the window is the safe half of "in flight".
  if (state.updateBusy && !force) return;
  $('settingsModal').hidden = true;
  state.setDraft = null;
  // An unsaved chat size was a preview; closing the window puts back the saved one.
  applyChatText();
  api('POST', '/api/settings/lock', { action: 'release' }).catch(() => {});
  state.settingsLock = null;
}
/** Throw the draft away and read the file again, without closing the window. */
export function revertSettings() {
  if (!state.config) return;
  state.setDraft = JSON.parse(JSON.stringify(state.config));
  state.setProvSelected = null;
  state.setKeyRevealed = false;
  state.setProvFetch = null;
  renderSettings();
  // A size that was typed but not saved must go back too: the preview is the only
  // part of this form that changes the page before Save.
  applyChatText();
  toast('Changes Discarded', 'The form shows what is saved in the config file.');
}
