// The LAN switch: what a second machine can see, and who is connected.
//
// Off at every start, whatever the file said — it used to be restored from the config
// and the listener came up bound to 0.0.0.0 while the LAN still could not reach it, so
// toggling off and on was what actually opened the door (29 Oct). A token-protected
// door should not open itself.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { renderDesk } from './desk.js';
import { renderStatus } from './status-line.js';

// ── remote access (LAN) ─────────────────────────────────────────
// The switch is the whole feature from here: GET says whether the listener is on
// the LAN, POST moves it. The link is only handed to the host itself.
export async function refreshRemote() {
  try {
    state.remote = await api('GET', '/api/remote');
    renderRemote();
  } catch { /* the status row keeps its last state */ }
}

export function renderRemote() {
  const info = state.remote || {};
  const on = Boolean(info.enabled);
  const toggle = $('remoteToggle');
  if (!toggle) return;
  toggle.setAttribute('aria-checked', String(on));
  toggle.title = on
    ? 'On — other devices on this LAN can open Synapse; click to stop sharing'
    : 'Off — this PC only; click to allow other devices on this LAN';
  const dot = $('remoteDot');
  if (dot) dot.className = 'status-dot ' + (on ? 'ok' : 'idle');
  const url = $('remoteUrl');
  if (url) {
    // The machine's name is what the operator reads out. The bare address used to
    // sit under it as "or http://192.168.1.38:8700/" - a second line with a
    // number in it that nobody reads out and that goes stale when DHCP moves the
    // PC. The name is the address; the number was noise (4 Nov).
    const named = String(info.namedUrl || '').trim();
    const address = String(info.url || '').trim();
    url.textContent = on ? (named ? `${named}/` : address ? `${address}/` : 'no LAN address') : '';
    url.title = named && address ? `This PC is ${info.host || 'named'}` : '';
  }
  const box = $('remoteInfo');
  if (box) box.hidden = !on;
  const token = $('remoteToken');
  if (token) token.hidden = !on || !info.token;
  // The clients line lives inside the box: off hides it with the address, on
  // shows it with the number it has right now.
  renderClients();
}

// Who is on the LAN. The address is what the other PC opens; the count sits
// under it in one line, because the rail has no room for a second row and a view
// on this PC is not a client of the address it already has. The names are the
// hover: a rail line that lists machines wraps or ellipses, and the operator
// asked for the count there and the list in the tooltip (4 Nov). When the network
// has not named a machine yet, its address is shown — that is more use than an
// absent name, and the lookup keeps trying (presence.js).
export function renderClients() {
  const el = $('remoteClients');
  if (!el) return;
  const names = [...new Set((state.views || []).filter((v) => !v.local).map((v) => v.name).filter(Boolean))];
  el.textContent = names.length ? `clients: ${names.length}` : 'clients: 0';
  el.title = names.length ? `Connected clients: ${names.join(', ')}` : 'No other device is connected.';
}

// The page was cut off. Everything behind the panel is stale, so it is covered
// and made inert, and only Close ends it: by closing the tab, or by replacing
// this document where the browser refuses window.close() for a tab the operator
// opened. There is deliberately no Escape and no backdrop click.
export let disconnectTimer = null;
export function showDisconnected(delay = 4000) {
  if (disconnectTimer) return;
  disconnectTimer = setTimeout(() => {
    disconnectTimer = null;
    const overlay = $('disconnect');
    if (!overlay || !overlay.hidden) return;
    overlay.hidden = false;
    document.querySelector('.app-shell')?.setAttribute('inert', '');
    document.body.classList.add('is-disconnected');
    $('disconnectClose')?.focus();
  }, delay);
}

export function clearDisconnected() {
  if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
  const overlay = $('disconnect');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.querySelector('.app-shell')?.removeAttribute('inert');
  document.body.classList.remove('is-disconnected');
}

export async function copyRemoteToken() {
  const value = state.remote?.token;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast('Token Copied', 'Paste it when Synapse asks for the token on the other PC.');
  } catch {
    toast('Could Not Copy', 'The clipboard was refused; the token is in data\\remote-token on this PC.');
  }
}

export async function toggleRemote() {
  const next = !state.remote?.enabled;
  const toggle = $('remoteToggle');
  if (toggle) toggle.disabled = true;
  try {
    state.remote = await api('POST', '/api/remote', { enabled: next });
    renderRemote();
    toast(
      next ? 'Remote Access On' : 'Remote Access Off',
      next
        ? 'Open the address on the other PC, then paste the TOKEN when it asks.'
        : 'Only this PC can open Synapse again.',
    );
    // The listener moves just after the response; read the settled state so the
    // address comes from the interface the switch is actually serving.
    setTimeout(refreshRemote, 900);
  } catch (err) {
    toast('Remote Access Failed', err.message);
    await refreshRemote();
  } finally {
    if (toggle) toggle.disabled = false;
  }
}
