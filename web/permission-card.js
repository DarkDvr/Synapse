// The card that asks the operator to allow something — drawn in the chat it belongs to.
//
// It used to be built in app.js out of every pending request on the machine, so one
// project's card appeared in another project's chat, and any project's card froze any
// project's composer (20 Nov). The rule now: a card is drawn only in its own chat —
// `permissionsHere()` — at the end of that chat's transcript, under the post it is
// about, where the operator can read what they are answering. Another project's card
// is announced by the rail and a toast, never drawn here.
//
// The engine blocks the session until every request is answered, and a worker's
// session is hidden from the rail — so a worker in *this* project is shown here,
// exactly like the Architect's own. The answer goes to the asking session, so a card
// is always answerable where it is.
import { esc } from './format.js';
import { serverNow } from './api.js';
import { state } from './state.js';
import { roleLabel, permissionsHere } from './run-view.js';
import { permissionNote } from './ask-note.js';

/** What this role is asking to do, in one sentence. Scope comes from the policy,
 *  so the sentence never claims the operator is the one outside their project. */
export function permissionLead(p) {
  const actor = p.role ? roleLabel(p.role) : 'The Architect';
  // The screen is not a file, and the sentence has to say so: this card is the
  // "may I use your PC" question, and it is the only one that takes the mouse.
  if (p.scope === 'desk') return `${actor} wants to use your screen.`;
  // A sign-in is a window on the operator's own desktop, so the sentence names the site
  // and says what the window is for (12 Nov).
  if (p.scope === 'browser') {
    const site = String(p.browserHost || p.browserUrl || '').replace(/^https?:\/\//i, '').split('/')[0];
    return `${actor} wants to open a browser window so you can sign in${site ? ` to ${site}` : ''}.`;
  }
  const action = String(p.action || '').toLowerCase();
  const verb =
    action === 'read'
      ? 'read a file'
      : action === 'shell' || action === 'bash'
        ? 'run a command'
        : action === 'execute'
          ? 'run code'
          : /^(edit|write|patch|create)$/.test(action)
            ? (p.files?.[0]?.status === 'added' ? 'create a file' : 'change a file')
            : 'use a tool';
  const where =
    p.scope === 'harness'
      ? ' inside Synapse'
      : p.scope === 'secret'
        ? ' in a saved-password folder'
        : p.scope === 'outside'
          ? ' outside this project'
          : p.scope === 'project'
            ? ' in this project'
            : '';
  return where
    ? `${actor} wants to ${verb}${where}.`
    : `${actor} wants to ${verb}, and the harness cannot tell where it lands.`;
}

// The permission countdown ──────────────────────────────────────
// "Auto-Permission: Allow Once will be picked in 7 seconds…", the same idea as the
// question's head: a number that moves is a claim the operator can check. Started
// when such a card is drawn, stopped when none is.
let permTick = 0;

function paintPermissionNotes() {
  const notes = document.querySelectorAll('[data-perm-due]');
  if (!notes.length) {
    stopPermCountdown();
    return;
  }
  for (const el of notes) el.textContent = permissionNote(el.dataset.permDue, serverNow());
}

function startPermCountdown() {
  if (!permTick) permTick = setInterval(paintPermissionNotes, 1000);
}

function stopPermCountdown() {
  if (permTick) {
    clearInterval(permTick);
    permTick = 0;
  }
}

/** The cards waiting in this chat's transcript. Empty for another project's asks. */
export function renderPermissionCards() {
  const here = permissionsHere();
  // A card that is on screen has been read: the woken-window guard only applies to
  // one drawn as the window came forward.
  const now = Date.now();
  const seen = state.permSeen || (state.permSeen = new Map());
  const live = new Set((here || []).map((p) => p.requestId).filter(Boolean));
  for (const id of live) if (!seen.has(id)) seen.set(id, now);
  for (const id of [...seen.keys()]) {
    if (!live.has(id)) {
      seen.delete(id);
      state.permWakeOk?.delete(id);
    }
  }
  const html = (here || [])
    .map((p) => {
      const actor = p.role ? roleLabel(p.role) : 'The Architect';
      const task = p.task || '';
      const paths = p.resolved && p.resolved.length ? p.resolved : p.resources || [];
      const files = p.files || [];
      const adds = files.reduce((n, f) => n + (f.additions || 0), 0);
      const dels = files.reduce((n, f) => n + (f.deletions || 0), 0);
      const diff = files.length
        ? `<details class="perm-diff"><summary>${files.length} file${files.length === 1 ? '' : 's'} · +${adds} −${dels}</summary><pre class="perm-res">${esc(
            files.map((f) => f.patch || f.file).join('\n'),
          )}</pre></details>`
        : '';
      const due = Number(p.autoPermissionsAt) || null;
      // The screen is a different question from a file: it is the operator's mouse,
      // keyboard and focus, and the answer lasts for the run rather than for one
      // command — so it has its own two buttons and no "Always Allow".
      const screen = p.scope === 'desk';
      const browserAsk = p.scope === 'browser';
      // The request is the card's name, so a card that arrives can slide in — and the
      // same card redrawn by the next poll is the same row, not a new one (20 Nov).
      const line = p.requestId ? ` data-line="perm:${esc(p.requestId)}"` : '';
      return `<div class="perm-card${screen ? ' is-screen' : ''}"${line}>
        <div class="perm-head"><span class="status-dot warn" role="img" aria-label="waiting"></span><span class="perm-head-text">${esc(
          actor,
        )} needs your ${browserAsk ? 'sign-in' : screen ? 'screen' : 'permission'}</span>${
          // The switch is on for the asking project: count down to the moment it is
          // allowed, in the head's right corner like the question's own note (3 Nov).
          due ? `<span class="perm-head-note" data-perm-due="${due}">${esc(permissionNote(due, serverNow()))}</span>` : ''
        }${task ? `<span class="perm-who">${esc(task)}</span>` : ''}</div>
        <p class="perm-lead">${esc(permissionLead(p))}</p>
        ${paths.length ? `<pre class="perm-res">${esc(paths.join('\n'))}</pre>` : ''}
        ${p.reason ? `<p class="perm-why">${esc(p.reason)}</p>` : ''}
        ${diff}
        <div class="perm-actions">
          <button class="btn btn-allow btn-sm" data-perm="once" data-perm-id="${esc(
            p.requestId,
          )}" title="${
            screen
              ? 'Let it use your mouse, keyboard and focus for the rest of this run. You can take the screen back from the badge at any time.'
              : browserAsk
                ? 'Open a window on the monitor you are looking at. It waits as long as you need; close it without signing in and this counts as a rejection.'
                : 'Do it this time only.'
          }">${screen ? 'Allow Screen' : browserAsk ? 'Allow Sign-In' : 'Allow Once'}</button>
          ${
            screen || browserAsk
              ? ''
              : `<button class="btn btn-warn btn-sm" data-perm="always" data-perm-id="${esc(
                  p.requestId,
                )}" title="${
                  p.action === 'shell' || p.action === 'bash'
                    ? 'Do it, and stop asking for this command and the files it names in this chat — extra arguments do not ask again.'
                    : 'Do it, and stop asking for this exact request in this chat.'
                }">Always Allow</button>`
          }
          <button class="btn btn-warn btn-sm" data-perm="reject" data-perm-id="${esc(
            p.requestId,
          )}" title="Say no. The role is told and carries on.">Reject</button>
          <button class="btn btn-warn btn-sm" data-perm-reason-open="${esc(
            p.requestId,
          )}" title="Say no, and tell the role why in your own words.">Reject With Reason</button>
          <button class="btn btn-stop btn-sm" data-perm-stop="${esc(
            p.requestId,
          )}" title="Stop the whole task.">Stop Run</button>
        </div>
      </div>`;
    })
    .join('');
  // A card that is going to be allowed by itself carries a countdown; the ticker
  // runs only while one is on screen.
  if (/data-perm-due="/.test(html)) startPermCountdown();
  else stopPermCountdown();
  return html;
}
