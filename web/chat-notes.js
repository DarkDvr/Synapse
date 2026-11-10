// The lines the page adds to a chat that are not messages: an alarm, a worker's
// lease, and a failure that has to outlive its toast.
//
// All three are page state kept beside the transcript rather than in it — none of
// them is a message the engine ever sent — and renderTranscript draws them in the
// same place, in the same order. One file because they answer one question: what did
// the harness notice that the conversation does not say?
import { state } from './state.js';
import { esc, hhmmss } from './format.js';

// Three things this file needs from app.js: which project is on screen, the key that
// identifies a folder, and a role's display name. Wired at boot.
const wired = {
  currentProject: () => null,
  dirKey: (dir) => String(dir || '').toLowerCase(),
  roleLabel: (role) => role,
};

/** Hand this module the three things that live in app.js. Called once, at boot. */
export function chatNotesWiring(fns) {
  Object.assign(wired, fns);
}

/** The alarms that belong in this conversation: this session's, or this project's
 *  when a delegated worker was the one that named the harness. */
export function alarmsHere() {
  const dir = wired.currentProject()?.directory;
  return state.alarms.filter(
    (a) => !a.sessionId || a.sessionId === state.sessionId || (a.dir && dir && wired.dirKey(a.dir) === wired.dirKey(dir)),
  );
}

/**
 * A model touched Synapse itself, said in the chat.
 *
 * Amber, like a compaction, because it is the same kind of news: something the
 * harness noticed about the run rather than a step in it. The command is cut to one
 * line and the full text is in the tooltip and the log — the operator cannot act on
 * it, so what they need is to know it happened, not to read it.
 */
/**
 * What an alarm is called, in the operator's words.
 *
 * It used to be one sentence chosen by testing `what` for "write" or "edit", so
 * every alarm whose text was not literally that — "WROTE INSIDE .synapse OUTSIDE ITS
 * FOLDER", "CHANGED DURING A WORKER RUN" — was titled "A model named Synapse in a
 * tool call". Beside a file name it read as nonsense, and on 10 Nov the operator
 * asked what these strange white errors were. Each kind now says what it is, and an
 * unknown kind still gets a sentence rather than a shouted constant.
 */
export function alarmTitle(what) {
  const kind = String(what || '').trim();
  if (/^WRITE INSIDE THE HARNESS$/i.test(kind)) return 'Something tried to write inside Synapse';
  if (/OUTSIDE ITS FOLDER/i.test(kind)) return 'A worker wrote outside its own folder';
  if (/CHANGED DURING A WORKER RUN/i.test(kind)) return "Synapse's own files changed while a worker ran";
  if (/shell command naming/i.test(kind)) return 'A model named Synapse in a tool call';
  return kind ? 'The harness noticed something' : 'The harness noticed something';
}

export function renderAlarm(a) {
  if (a.prohibited) {
    const target = (a.paths || []).join(' | ');
    const shown = target.length > 150 ? `${target.slice(0, 149)}…` : target;
    const who = String(a.note || '');
    return `<div class="chat-alarm is-prohibited" title="${esc(`PROHIBITED: ${a.action} ${target}${who ? ` ${who}` : ''}`)}">
    <span class="chat-alarm-mark">⛔</span>
    <span class="chat-alarm-text">PROHIBITED · ${esc(a.action)}${shown ? ` ${esc(shown)}` : ''}${who ? ` · ${esc(who)}` : ''}</span>
  </div>`;
  }
  const title = alarmTitle(a.what);
  const detail = (a.paths || []).join(' | ');
  const shown = detail.length > 150 ? `${detail.slice(0, 149)}…` : detail;
  return `<div class="chat-alarm" title="${esc(`${title}: ${detail}${a.note ? ` — ${a.note}` : ''}`)}">
    <span class="chat-alarm-mark">⚠</span>
    <span class="chat-alarm-text">${esc(title)}${shown ? ` · ${esc(shown)}` : ''}</span>
  </div>`;
}

/**
 * A worker's lease: its own estimate of how long a long command will take, with a
 * clock in the chat that counts down. Granted, extended, expired, or ended by the
 * run finishing.
 */
export function noteLease(ev) {
  const key = `${wired.dirKey(ev.dir)}|${ev.task || ''}`;
  if (ev.kind === 'granted' || ev.kind === 'extended') {
    state.leases.set(key, {
      dir: ev.dir || null,
      task: ev.task || '',
      role: ev.role || '',
      until: Number(ev.until) || 0,
      minutes: Number(ev.minutes) || 0,
      reason: String(ev.reason || ''),
      extended: Boolean(ev.extended),
      expired: false,
      at: Date.now(),
    });
  } else if (ev.kind === 'expired') {
    const lease = state.leases.get(key);
    if (lease) lease.expired = true;
  }
}

export function leasesHere() {
  const dir = wired.currentProject()?.directory;
  return [...state.leases.values()].filter(
    (lease) => !lease.dir || !dir || wired.dirKey(lease.dir) === wired.dirKey(dir),
  );
}

export function renderLease(lease) {
  const role = wired.roleLabel(lease.role) || 'Worker';
  const reason = lease.reason ? ` · “${esc(lease.reason)}”` : '';
  if (lease.expired) {
    return `<div class="chat-lease is-expired" data-lease="${esc(`${lease.dir}|${lease.task}`)}">
      <span class="chat-lease-mark">⏱</span>
      <span class="chat-lease-text">Lease ended for ${esc(role)} — asking whether it needs more${reason}</span>
    </div>`;
  }
  const clock = hhmmss(Math.max(0, lease.until - Date.now()));
  const asked = hhmmss(Math.max(0, lease.minutes * 60_000));
  return `<div class="chat-lease" data-lease="${esc(`${lease.dir}|${lease.task}`)}">
    <span class="chat-lease-mark">⏱</span>
    <span class="chat-lease-text">${esc(role)} asked for ${lease.extended ? 'more' : `a ${asked} lease`} ·
      <span class="chat-lease-clock" data-lease-until="${Number(lease.until) || 0}">${esc(clock)}</span> left${reason}</span>
  </div>`;
}

/**
 * A failure, in the conversation, in red, and kept.
 *
 * Measured 25 Oct: a message with a picture was refused because the body was too
 * large, the panel said so in a toast that vanished in four seconds, and nothing
 * was left anywhere the operator could look. A toast is the right shape for "saved"
 * and the wrong shape for "your message was not sent": the reason is the thing they
 * need, and they need it after the toast is gone.
 */
const CHAT_ERRORS_KEY = 'synapse.chatErrors';
const CHAT_ERRORS_MAX = 20;

function chatErrorsAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHAT_ERRORS_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function addChatError({ title, detail }) {
  const id = state.sessionId || 'no-session';
  const all = chatErrorsAll();
  const list = Array.isArray(all[id]) ? all[id] : [];
  const entry = {
    at: Date.now(),
    sessionId: state.sessionId || null,
    title: String(title || 'Something failed'),
    detail: String(detail || '').slice(0, 20000),
  };
  // The same failure twice in a row is one line, not two: a retry that fails the
  // same way should not fill the conversation.
  const last = list[list.length - 1];
  if (!(last && last.title === entry.title && last.detail === entry.detail)) list.push(entry);
  all[id] = list.slice(-CHAT_ERRORS_MAX);
  try { localStorage.setItem(CHAT_ERRORS_KEY, JSON.stringify(all)); } catch { /* full storage must not break a turn */ }
  return entry;
}

export function chatErrorsHere() {
  const id = state.sessionId || 'no-session';
  const list = chatErrorsAll()[id];
  return Array.isArray(list) ? list : [];
}

/** One failure: what happened, the reason, and a way to take the whole thing away. */
export function renderChatError(e) {
  const detail = String(e.detail || '');
  const long = detail.length > 220 || detail.split('\n').length > 3;
  const shown = long ? `${detail.slice(0, 220).trimEnd()}…` : detail;
  return `<div class="chat-error" data-chat-error>
    <div class="chat-error-head"><span class="chat-error-mark">!</span><span class="chat-error-title">${esc(e.title)}</span></div>
    ${shown ? `<div class="chat-error-detail">${esc(shown)}</div>` : ''}
    ${long ? `<button type="button" class="chat-error-copy" data-copy-error="${esc(e.at)}">Copy Error</button>` : ''}
  </div>`;
}
