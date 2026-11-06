// The console, and the channel to the window's own bar.
//
// The window — its bar, its buttons, its size — belongs to the shell, so the page
// neither draws nor drives any of it. This module carries the two things only the
// shell knows: the console, which it writes, and whether the server process is
// running, which only it can start and stop.
//
// It was the first screen to leave app.js. The one thing it needs from there is
// renderStatus (the rail's dots), and it asks for it on the way in rather than
// importing the file that wires every handler — no cycle, no load-order question.
import { state } from './state.js';
import { $ } from './dom.js';

let renderStatus = () => {};

/** Called once by app.js: the rail's status dots live there. */
export function consoleWiring({ onStatusChange }) {
  if (typeof onStatusChange === 'function') renderStatus = onStatusChange;
}

// ── the shell's channel ─────────────────────────────────────────────────
// The window — its bar, its buttons, its size — belongs to the shell, so the page
// neither draws nor drives any of it. The channel carries the two things only the
// shell knows: the console, which it writes, and whether the server process is
// running, which only it can start and stop.
export function initShellChannel() {
  const host = window.chrome?.webview;
  if (!host) return;

  host.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'console') {
      consoleOffset = msg.offset ?? consoleOffset;
      appendConsole(msg.text, msg.dropped);
    } else if (msg.kind === 'server') {
      setServerState(msg.state, msg.reason);
    }
  });

  // Say hello. The shell answers with the state of the server, and re-checks which
  // of its windows need the resize band forwarded — Chromium creates the renderer
  // after the navigation completes, so a page that has loaded is the best evidence
  // that it now exists.
  host.postMessage({ kind: 'ready' });
}

// ── the console ─────────────────────────────────────────────────────────
// What the server prints, written by the app rather than read from the server —
// so it still works when the server is stopped, which is exactly when a console
// is worth opening. The whole ring is asked for on open (offset 0), then only
// what is new, every 750ms while the panel is up.
let consoleOffset = 0;
let consolePoll = 0;
let consoleFocus = null;
const CONSOLE_NOTE = 'Everything the server has printed. Select any of it to copy.';

export function openConsole() {
  const modal = $('consoleModal');
  if (!modal || !modal.hidden) return;
  consoleFocus = document.activeElement;
  consoleOffset = 0;
  $('consoleBody').textContent = '';
  $('consoleNote').textContent = state.server?.reason || CONSOLE_NOTE;
  paintConsolePill(state.server?.state);
  modal.hidden = false;
  $('consoleBody').focus();

  const host = window.chrome?.webview;
  if (!host) {
    // A browser tab has no shell to ask, and inventing a console there would be
    // the mock this project forbids.
    $('consoleNote').textContent = 'The console belongs to the app: open Synapse.exe to watch the server there.';
    paintConsolePill('not in the app');
    return;
  }
  host.postMessage({ kind: 'console', offset: consoleOffset });
  stopConsolePoll();
  consolePoll = setInterval(() => host.postMessage({ kind: 'console', offset: consoleOffset }), 750);
}

export function closeConsole() {
  const modal = $('consoleModal');
  if (modal) modal.hidden = true;
  stopConsolePoll();
  // Back to whatever opened it, so the keyboard does not start over at the top.
  (consoleFocus || $('consoleBtn'))?.focus?.();
  consoleFocus = null;
}

function stopConsolePoll() {
  if (consolePoll) { clearInterval(consolePoll); consolePoll = 0; }
}

function appendConsole(text, dropped) {
  const body = $('consoleBody');
  if (!body) return;
  // `dropped` means the ring has already discarded our position, so what arrived
  // is the whole window and the text has to be replaced, not appended to.
  if (dropped) body.textContent = '';
  if (!text) return;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  body.appendChild(document.createTextNode(text));
  if (atBottom) {
    // Twice: the browser clamps scrollTop to the height it knew about before the
    // text was laid out, so one assignment lands short of the newest line.
    body.scrollTop = body.scrollHeight;
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  }
}

/** What the app says about the server, which the server cannot say at all. */
export function setServerState(serverState, reason) {
  state.server = { state: serverState, reason: reason || '' };
  paintConsolePill(serverState);
  $('consoleNote').textContent = reason || CONSOLE_NOTE;
  // The title bar says it too. That strip is the only thing on screen that does
  // not depend on the page underneath, which is exactly the state it describes.
  const alert = $('titlebarAlert');
  if (alert) {
    const down = serverState === 'stopped' || serverState === 'failed';
    alert.hidden = !down;
    alert.textContent = serverState === 'failed' ? 'Server failed' : 'Server stopped';
  }
  renderStatus();
}

function paintConsolePill(serverState) {
  const pill = $('consoleState');
  if (pill) {
    pill.textContent = serverState || 'unknown';
    pill.className = 'console-state'
      + (serverState === 'running' ? ' is-ok'
        : serverState === 'stopped' || serverState === 'failed' ? ' is-err' : '');
  }
  renderConsoleActions(serverState);
}

/**
 * The three server buttons, mirroring the tray menu: there is nothing to start
 * while it runs and nothing to stop while it is down, so the dead one is dead.
 * Outside the app none of them can do anything at all.
 */
function renderConsoleActions(serverState) {
  const up = serverState === 'running' || serverState === 'starting';
  const host = window.chrome?.webview;
  for (const [id, allowed] of [['consoleStart', !up], ['consoleRestart', up], ['consoleStop', up]]) {
    const btn = $(id);
    if (btn) btn.disabled = !host || !allowed;
  }
}
