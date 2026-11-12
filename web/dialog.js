// The two dialogs: one question with buttons, and one error you have to read.
//
// They are the same machinery with different clothes — a modal that returns a promise
// for the answer, closes on Escape when it is safe to, and never leaves a caller
// waiting on a click that cannot happen. The error popup is the one that is not a
// question: it is news, and it is the reason a failure is on screen at all.
//
// Nothing comes from app.js.
import { esc } from './format.js';
import { $ } from './dom.js';
import { state } from './state.js';
import { renderTranscript } from './transcript.js';

// ── error popup ─────────────────────────────────────────────────
export function openError(title, text, opts = {}) {
  $('errorHeading').textContent = title;
  $('errorBadge').textContent = opts.badge || '!';
  const lead = $('errorLead');
  lead.textContent = opts.lead || '';
  lead.hidden = !opts.lead;
  const detail = $('errorText');
  detail.textContent = text || '';
  detail.hidden = !text;
  const note = $('errorNote');
  note.textContent = opts.note || '';
  note.hidden = !opts.note;
  $('errorModal').classList.toggle('is-alarm', Boolean(opts.alarm));
  $('errorModal').hidden = false;
  $('closeError').focus();
}

/** An agent touched Synapse itself. Not an error to retry and not something the
 *  operator can act on: it is *news*, and the log has the detail. It used to open
 *  a modal — one click to close, nothing to do — so it is a line in the chat now,
 *  in the same amber as a compaction, and the popup is gone. */
export function openAlarm(ev) {
  const what = String(ev.what || 'something touched Synapse itself');
  const paths = (ev.paths || []).map(String);
  // Which project this belongs to, when it came from a delegated run: a worker's
  // session cannot be opened from the rail, so a line only shown in the session it
  // came from would be a line the operator never sees.
  const run = ev.sessionId ? [...state.runs.values()].find((r) => r.workerId === ev.sessionId) : null;
  const line = {
    at: Date.now(),
    sessionId: ev.sessionId || null,
    dir: run?.dir || null,
    what,
    paths,
    note: ev.note ? String(ev.note) : '',
  };
  state.alarms.push(line);
  // One page, not a history: the log keeps every one of them.
  if (state.alarms.length > 20) state.alarms.splice(0, state.alarms.length - 20);
  renderTranscript();
}
export function closeError() { $('errorModal').hidden = true; }

/**
 * A tool tried to change a prohibited path. This is the chat's red line: the
 * worker that asked may be a hidden session, so the alarm is carried on the
 * decision broadcast and shown in the project's own chat (4 Nov).
 */
export function openProhibition(entry) {
  if (!entry) return;
  const run = entry.sessionId ? [...state.runs.values()].find((r) => r.workerId === entry.sessionId) : null;
  const paths = (Array.isArray(entry.resolved) && entry.resolved.length ? entry.resolved : entry.resources || []).map(String);
  state.alarms.push({
    at: Number(entry.at) || Date.now(),
    sessionId: entry.sessionId || null,
    dir: run?.dir || entry.directory || null,
    prohibited: true,
    action: String(entry.action || 'change'),
    paths,
    note: entry.role ? `by ${entry.role}${entry.task ? ` (${entry.task})` : ''}` : '',
  });
  if (state.alarms.length > 20) state.alarms.splice(0, state.alarms.length - 20);
  renderTranscript();
}

// ── generic dialog (confirmations and small forms) ──────────────
export let dialogResolve = null;
export let dialogFields = [];
export let dialogDismissable = true;
export let dialogOkResult;

export function openDialog({
  title,
  message = '',
  fields = [],
  confirmLabel = 'OK',
  danger = false,
  extra = null,
  okResult = undefined,
  dismissable = true,
  tone = null,
  afterRender,
}) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialogFields = fields;
    dialogDismissable = dismissable;
    dialogOkResult = okResult;
    $('dialogTitle').textContent = title;
    $('dialogMessage').textContent = message;
    $('dialogMessage').hidden = !message;
    $('dialogOk').textContent = confirmLabel;
    $('dialogOk').className = `btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`;
    // A dialog may gate its own confirm (the deliverables in `bin\` have to be
    // ticked first), so the button is re-armed on every open instead of inheriting
    // the state the last dialog left it in.
    $('dialogOk').disabled = false;
    // A third choice, for the one dialog that needs three (a folder that already
    // exists: cancel, wipe it, or carry on with it).
    const extraBtn = $('dialogExtra');
    extraBtn.hidden = !extra;
    if (extra) {
      extraBtn.textContent = extra.label;
      extraBtn.dataset.result = extra.result || 'extra';
      extraBtn.className = `btn btn-sm ${extra.danger ? 'btn-danger' : 'btn-secondary'}`;
    }
    // "Non-bypassable" means exactly this: no close button, no backdrop dismiss, no
    // Escape. The operator must pick one of the answers.
    $('dialogClose').hidden = !dismissable;
    document.querySelector('#dialogModal .modal')?.classList.toggle('is-clash', tone === 'clash');
    $('dialogBody').innerHTML = fields
      .map((f) => {
        // A checklist is not one control inside one label: every row is its own
        // label, or clicking a row's text would toggle the first box instead.
        if (f.type === 'checklist') {
          const rows = f.options
            .map(
              (o) =>
                `<label class="dlg-check"><input type="checkbox" data-check="${esc(o.v)}"${o.checked ? ' checked' : ''} />` +
                `<span>${esc(o.l)}</span>` +
                (o.hint ? `<small>${esc(o.hint)}</small>` : '') +
                `</label>`,
            )
            .join('');
          return `<div class="set-field wide"><span>${esc(f.label)}</span><div class="dlg-checklist">${rows}</div></div>`;
        }
        // Skills carry two levels: allowed (the engine refuses anything else) and
        // required (the brief demands it, and the runner reports it to the
        // Architect if the worker never loaded it). Two boxes per row; the
        // required box is dead until the skill is allowed, so the two lists can
        // never disagree.
        if (f.type === 'skills') {
          const rows = f.options
            .map(
              (o) =>
                `<div class="dlg-skill">` +
                `<label class="dlg-check"><input type="checkbox" data-skill-allow="${esc(o.v)}"${o.allowed ? ' checked' : ''} />` +
                `<span>${esc(o.l)}</span>` +
                (o.hint ? `<small>${esc(o.hint)}</small>` : '') +
                `</label>` +
                `<label class="dlg-must" title="The brief requires it">` +
                `<input type="checkbox" data-skill-must="${esc(o.v)}"${o.must ? ' checked' : ''}${o.allowed ? '' : ' disabled'} />` +
                `<span>Required</span>` +
                `</label>` +
                `</div>`,
            )
            .join('');
          return `<div class="set-field wide"><span>${esc(f.label)}</span><div class="dlg-checklist">${rows}</div></div>`;
        }
        if (f.type === 'check') {
          // One flag, not a list: the dialog's checklist is a set of choices, and
          // readDialog collects every checkbox it finds for those. A separate
          // attribute keeps the two kinds apart.
          //
          // It gets its own bordered row with a title and a line of consequence:
          // as a bare checkbox under the message it read as the tail of the
          // sentence, which is the worst thing an option that deletes a plan can
          // read as.
          return `<label class="dlg-option">
            <input type="checkbox" data-flag="${esc(f.name)}"${f.value ? ' checked' : ''} />
            <span class="dlg-option-text">
              <span>${esc(f.label)}</span>
              ${f.hint ? `<small>${esc(f.hint)}</small>` : ''}
            </span>
          </label>`;
        }
        const control = f.type === 'select'
          ? `<select id="dlg-${esc(f.name)}">${f.options
              .map((o) => `<option value="${esc(o.v)}"${o.v === f.value ? ' selected' : ''}>${esc(o.l)}</option>`)
              .join('')}</select>`
          : f.type === 'textarea'
            ? `<textarea id="dlg-${esc(f.name)}" rows="4" placeholder="${esc(f.placeholder ?? '')}">${esc(f.value ?? '')}</textarea>`
            : `<input id="dlg-${esc(f.name)}" type="text" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" />`;
        // A hint under a plain field: the rename dialog uses it to say what the
        // folder name will do, and the path it will become (12 Nov).
        const hint = f.hint ? `<small class="dlg-hint" data-hint-for="${esc(f.name)}">${esc(f.hint)}</small>` : '';
        return `<label class="set-field wide"><span>${esc(f.label)}</span>${control}${hint}</label>`;
      })
      .join('');
    $('dialogModal').hidden = false;
    const first = $('dialogBody').querySelector('input, select');
    first?.focus();
    first?.select?.();
    afterRender?.();
  });
}

export function readDialog() {
  if (!dialogFields.length) return true;
  const values = {};
  // Single flags first: they are read by their own attribute, so a checklist of
  // options and a yes/no choice can live in the same dialog without meeting.
  for (const el of $('dialogBody').querySelectorAll('input[data-flag]')) {
    values[el.dataset.flag] = el.checked;
  }
  for (const f of dialogFields) {
    if (f.type === 'check') continue;
    if (f.type === 'checklist') {
      values[f.name] = [...$('dialogBody').querySelectorAll('input[data-check]')]
        .filter((el) => el.checked)
        .map((el) => el.dataset.check);
      continue;
    }
    if (f.type === 'skills') {
      const body = $('dialogBody');
      values[f.name] = [...body.querySelectorAll('input[data-skill-allow]')]
        .filter((el) => el.checked)
        .map((el) => el.dataset.skillAllow);
      values.mustLoad = [...body.querySelectorAll('input[data-skill-must]')]
        .filter((el) => el.checked)
        .map((el) => el.dataset.skillMust);
      continue;
    }
    const el = $(`dlg-${f.name}`);
    if (el) values[f.name] = el.value.trim();
  }
  return values;
}

export function closeDialog(result) {
  $('dialogModal').hidden = true;
  const resolve = dialogResolve;
  dialogResolve = null;
  resolve?.(result);
}
