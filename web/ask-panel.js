// The question, in the chat: what the engine asked, the options, and the answer.
//
// A question is not an overlay — it is the last thing in the conversation, so the
// operator can read what was said before answering it. That is why this module also
// sizes the box: the post has to sit in the chat, at the top, with the answer panel
// inside it, and the chat must not move under the reader while it appears.
//
// Three things come from app.js and are wired at boot: how long an answer waits
// before it is taken automatically, the cards that are waiting, and the rail.
import { state } from './state.js';
import { esc } from './format.js';
import { $ } from './dom.js';
import { serverNow } from './api.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { askHeadNote, answerTimeline } from './ask-note.js';
import { fitChatHeight, wideLayout } from './chat-geometry.js';
import { stopFollowingChat } from './chat-scroll.js';
import { currentForm } from './run-view.js';
import { renderTranscript } from './transcript.js';
import { renderComposer } from './composer.js';

const missing = (name) => () => {
  throw new Error(`ask-panel.js: ${name} was not wired at boot`);
};
const wired = {
  answerWaitSec: missing('answerWaitSec'),
  refreshPending: missing('refreshPending'),
  renderTree: missing('renderTree'),
};

/** Hand this module the three things that live in app.js. Called once, at boot. */
export function askPanelWiring(fns) {
  Object.assign(wired, fns);
}

function askOption(kind, name, value, label, description) {
  // The models mark their recommendation in the label — "(Recommended)", the
  // convention the question tool documents. Take it out of the sentence and give
  // it a chip: readable as a label, still obvious at a glance.
  const raw = String(label ?? '');
  const recommended = /\(\s*recommended\s*\)\s*$/i.test(raw);
  const text = recommended ? raw.replace(/\s*\(\s*recommended\s*\)\s*$/i, '') : raw;
  return `<label class="ask-opt">
    <input type="${kind}" name="${esc(name)}" value="${esc(value)}" />
    <span class="ask-opt-text">
      <span class="ask-opt-label">${esc(text)}${recommended ? '<span class="ask-rec">Recommended</span>' : ''}</span>
      ${description ? `<span class="ask-opt-desc">${esc(description)}</span>` : ''}
    </span>
  </label>`;
}

/** A choice question may also be answered in the operator's own words — the
 *  engine marks that with `custom`, and so does the tool these models call. */
function askCustom(kind, name) {
  return `<div class="ask-opt ask-opt-other">
    <label class="ask-other-pick">
      <input type="${kind}" name="${esc(name)}" value="__custom" data-ask-custom="1" />
      <span class="ask-opt-label">Something Else…</span>
    </label>
    <textarea class="ask-input ask-other-text" rows="1" placeholder="Type it here" disabled></textarea>
  </div>`;
}

/** One field of a form, rendered as the control its type deserves. */
function askField(field, index, all) {
  const key = String(field.key ?? `q${index}`);
  const name = `ask-${key}`;
  const type = String(field.type || 'string');
  const options = Array.isArray(field.options) ? field.options : [];
  // The engine calls this the question's `header` — a short label for telling
  // several questions apart. With only one, it just sits above the real question
  // and models often write a slug there ("--reverse meaning"), which reads like a
  // broken title. Show it only when it separates questions, or when there is no
  // question text to show instead.
  const showTitle =
    field.title &&
    ((all?.length || 1) > 1 || !field.description) &&
    // The engine often sends the same sentence as both title and description
    // ("Which layout?" twice on screen). One line is the question; a second copy
    // above it is noise.
    String(field.title).trim() !== String(field.description || '').trim();
  const title = showTitle ? `<p class="ask-q-title">${esc(field.title)}</p>` : '';
  const text = field.description ? `<p class="ask-q-text">${esc(field.description)}</p>` : '';
  const req = field.required ? '<span class="ask-req" title="Required">required</span>' : '';

  let body;
  if (type === 'boolean') {
    body = `<div class="ask-opts">${askOption('checkbox', name, 'true', field.title || 'Yes', '')}</div>`;
  } else if (type === 'multiselect') {
    body =
      `<div class="ask-opts">${options.map((o) => askOption('checkbox', name, o.value, o.label, o.description)).join('')}` +
      `${field.custom ? askCustom('checkbox', name) : ''}</div>`;
  } else if (options.length) {
    body =
      `<div class="ask-opts">${options.map((o) => askOption('radio', name, o.value, o.label, o.description)).join('')}` +
      `${field.custom ? askCustom('radio', name) : ''}</div>`;
  } else if (type === 'external') {
    // Nothing to answer: the field is a door to somewhere else.
    body = `<a class="ask-link" href="${esc(field.url || '#')}" target="_blank" rel="noreferrer noopener">${esc(field.title || field.url || 'Open')}</a>`;
  } else if (type === 'number' || type === 'integer') {
    const min = field.minimum != null ? ` min="${esc(field.minimum)}"` : '';
    const max = field.maximum != null ? ` max="${esc(field.maximum)}"` : '';
    body = `<input class="ask-input" type="number" data-ask-key="${esc(key)}"${min}${max} value="${esc(field.default ?? '')}" />`;
  } else {
    body = `<input class="ask-input" type="text" data-ask-key="${esc(key)}" placeholder="${esc(field.placeholder || '')}" value="${esc(field.default ?? '')}" />`;
  }

  // `when` is the engine's own conditional: the field only exists if another
  // answer says so. Hidden fields are not rendered, and never answer anything.
  const when = Array.isArray(field.when) && field.when.length
    ? ` data-ask-when="${esc(JSON.stringify(field.when))}"`
    : '';
  return `<div class="ask-field" data-ask-field="${esc(key)}" data-ask-index="${index}" data-ask-type="${esc(type)}"${when}${
    field.required ? ' data-ask-required="1"' : ''
  }>${title}${text}${req}${body}</div>`;
}

export function renderAskPanel() {
  const host = askHost();
  if (!host) return;
  const form = state.view === 'session' ? currentForm() : null;
  if (!form) {
    state.askSig = '';
    state.askPage = 0;
    state.askNote = null;
    stopAskCountdown();
    host.hidden = true;
    host.innerHTML = '';
    syncAskState();
    return;
  }
  // The panel is polled like everything else, and rebuilding it would throw away
  // whatever the operator had already answered — so it is only rebuilt when the
  // form itself changed. Answers live in the DOM, and the signature deliberately
  // says nothing about them.
  const sig = `${form.id}|${(form.fields || [])
    .map((f) => `${f.key}:${f.type}:${(f.options || []).map((o) => o.value).join(',')}`)
    .join(';')}`;
  // What the countdown measures against, refreshed on every poll: the server says
  // when the first page appeared (`autoAnswerFirstAt`, its clock), so a reload or a
  // slow sweep does not restart the number. Each page gets its own wait; the panel
  // turns the page when its countdown runs out and the reply goes at the last one.
  state.askNote = {
    here: form.sessionId === state.sessionId,
    // The asking chat's own switch when the server said so; the open chat's when it
    // did not (an older snapshot).
    autoAnswer: (form.autoAnswer ?? state.automation?.autoAnswer) === true,
    wait: wired.answerWaitSec(),
    firstAt: Number(form.autoAnswerFirstAt) || null,
    pages: Math.max(1, Number(form.autoAnswerPages) || 1),
  };
  startAskCountdown();
  if (sig === state.askSig) {
    host.hidden = false;
    mountAskPost();
    paintAskNote();
    return;
  }
  state.askSig = sig;
  host.hidden = false;
  host.innerHTML = `<div class="ask-panel" role="dialog" aria-label="Question waiting for an answer" data-ask="${esc(form.id)}">
    <div class="ask-head">
      <span class="ask-dot" aria-hidden="true"></span>
      <span class="ask-head-title">${esc(form.title || 'Input Needed')}</span>
      <span class="ask-head-note">${esc(paintAskNoteText())}</span>
    </div>
    <div class="ask-fields">${(form.fields || []).map(askField).join('')}</div>
    <div class="ask-actions">
      <span class="ask-state" data-ask-state></span>
      <span class="ask-progress" data-ask-progress hidden></span>
      <button class="btn btn-back btn-sm" data-ask-back hidden>Back</button>
      <button class="btn btn-ask btn-sm" data-ask-next hidden>Next</button>
      <button class="btn btn-ask btn-sm" data-form-reply="${esc(form.id)}" hidden>Submit Answer</button>
    </div>
  </div>`;
  // A new form starts at its first question. The page is *not* reset on a poll:
  // an unchanged signature returns above, so a rebuild never moves the operator.
  state.askPage = 0;
  mountAskPost();
  refreshAskPanel();
  // A question is the thing the run is waiting on: show it, even if the operator
  // had scrolled up to read. It goes to the very top of the chat, so the question is
  // the first thing read; the panel's header leaves room on its right for the
  // floating jump buttons, which otherwise sat over it.
  stopFollowingChat();
  requestAnimationFrame(() => {
    const el = $('transcript');
    const host = askHost();
    if (!el || !host) return;
    const top = host.getBoundingClientRect().top - el.getBoundingClientRect().top;
    if (Math.abs(top) > 2) el.scrollTop += top - 6;
  });
}

/**
 * The question panel's node, captured once.
 *
 * The transcript's `innerHTML` is replaced on every change, and the panel lives
 * inside it — so a rebuild *detaches* it. Looking it up again with `getElementById`
 * cannot work at that moment: a detached node is not in the document, the lookup
 * returns null, and the code that was supposed to re-append it gives up. That is
 * exactly how the panel vanished for a whole turn on 2 Nov: the composer said a
 * question was waiting, and there was no question on screen until a reload rebuilt
 * the page. Holding the node makes "moved, never rebuilt" true in the case that
 * matters.
 */
export let askHostEl = null;

export function askHost() {
  return askHostEl || (askHostEl = $('askHost'));
}

// The countdown beside a question's title. One interval while a question is on
// screen, writing only that line's text: the panel itself is never rebuilt, so an
// answer the operator has already given survives every tick (the rule that stops
// the polled panel clearing itself).
export let askTick = 0;

export function startAskCountdown() {
  if (askTick) return;
  askTick = setInterval(paintAskNote, 1000);
}

export function stopAskCountdown() {
  if (askTick) {
    clearInterval(askTick);
    askTick = 0;
  }
}

export function paintAskNote() {
  const host = askHost();
  const note = host?.querySelector?.('.ask-head-note');
  if (!note || !state.askNote) return;
  // Auto-Answer turns the page when a page's wait runs out — that is the whole of
  // it: wait, take the recommended options on this page, "click" Next, and the
  // reply goes to the engine after the last page. Paging is never skipped, so every
  // question still gets its own look and its own countdown (3 Nov).
  const n = state.askNote;
  if (n.autoAnswer && n.firstAt) {
    const now = serverNow();
    const timeline = answerTimeline({ firstAt: n.firstAt, wait: n.wait, pages: n.pages, now });
    // Forward only: an operator who clicked ahead is not dragged back by the clock.
    const page = Math.max(state.askPage, timeline.page);
    if (page !== state.askPage) {
      state.askPage = page;
      applyAskPage();
    }
    const end = n.firstAt + (page + 1) * Math.max(1, n.wait) * 1000;
    note.textContent = askHeadNote({ here: n.here, autoAnswer: true, seconds: Math.max(0, Math.ceil((end - now) / 1000)) });
    return;
  }
  note.textContent = askHeadNote({ here: n.here, autoAnswer: false });
}

/** The same sentence, without touching the DOM — for the first render. */
function paintAskNoteText() {
  const n = state.askNote;
  if (!n) return '';
  if (!n.autoAnswer || !n.firstAt) return askHeadNote({ here: n.here, autoAnswer: n.autoAnswer });
  const timeline = answerTimeline({ firstAt: n.firstAt, wait: n.wait, pages: n.pages, now: serverNow() });
  return askHeadNote({ here: n.here, autoAnswer: true, seconds: timeline.seconds });
}

/**
 * The node is *moved*, never rebuilt: the transcript's markup is replaced on every
 * change, so a panel that lived inside it would lose whatever had been answered the
 * first time a poll rebuilt the chat. Appending the same element again keeps its
 * fields, its page and its focus, and makes it the last thing in the conversation —
 * which is the whole point of moving it out of the overlay.
 */
export function mountAskPost() {
  const host = askHost();
  const el = $('transcript');
  if (!host || !el) return;
  if (host.hidden || !currentForm()) return;
  if (host.parentElement !== el || el.lastElementChild !== host) el.appendChild(host);
}

/** The panel's answers, in the shape the engine's form reply wants. */
function collectAskAnswer(form) {
  const panel = document.querySelector('.ask-panel');
  const answer = {};
  if (!panel) return answer;
  for (const field of form.fields || []) {
    const key = String(field.key ?? '');
    const holder = panel.querySelector(`[data-ask-field="${CSS.escape(key)}"]`);
    if (!holder || holder.hidden) continue;
    const type = String(field.type || 'string');
    const one = (sel) => holder.querySelector(sel);
    if (field.hidden || type === 'external') continue;
    if (type === 'boolean') {
      answer[key] = Boolean(one('input[type="checkbox"]')?.checked);
    } else if (type === 'multiselect') {
      const picked = [...holder.querySelectorAll('input[type="checkbox"]:checked')]
        .filter((el) => !el.hasAttribute('data-ask-custom'))
        .map((el) => el.value);
      const other = one('.ask-other-text');
      if (other && other.value.trim()) picked.push(other.value.trim());
      answer[key] = picked;
    } else if (Array.isArray(field.options) && field.options.length) {
      const checked = one('input[type="radio"]:checked');
      if (!checked) continue;
      const other = one('.ask-other-text');
      answer[key] = checked.hasAttribute('data-ask-custom')
        ? String(other?.value || '').trim()
        : checked.value;
    } else if (type === 'number' || type === 'integer') {
      const el = one(`[data-ask-key="${CSS.escape(key)}"]`);
      answer[key] = el?.value === '' || el?.value === undefined ? null : Number(el.value);
    } else {
      answer[key] = String(one(`[data-ask-key="${CSS.escape(key)}"]`)?.value ?? '');
    }
  }
  return answer;
}

/** The questions of a form in the order they are asked. A field the engine marks
 *  `hidden` is not a question at all and never becomes a page. */
function askPageList(panel, form) {
  return (form?.fields || [])
    .map((field, index) => ({ field, holder: panel.querySelector(`.ask-field[data-ask-index="${index}"]`) }))
    // `when` hides a question whose premise the operator has not chosen; it must
    // not become a page they cannot reach an answer for either.
    .filter(({ field, holder }) => !field.hidden && holder && !holder.hidden);
}

/** Show the question at `state.askPage` and nothing else. A five-question form
 *  used to be one long scroll and the questions below the fold were missed.
 *  Every field stays in the DOM — off-page is a class, never `hidden` — so
 *  answers survive paging and the `when` rules keep working. */
export function applyAskPage(panel = document.querySelector('.ask-panel')) {
  const form = currentForm();
  if (!panel || !form) return;
  const pages = askPageList(panel, form);
  const last = Math.max(0, pages.length - 1);
  if (state.askPage > last) state.askPage = last;
  if (state.askPage < 0) state.askPage = 0;
  const active = pages[state.askPage]?.holder || null;
  for (const holder of panel.querySelectorAll('.ask-field')) {
    holder.classList.toggle('ask-page-off', Boolean(active) && holder !== active);
  }
  const many = pages.length > 1;
  const progress = panel.querySelector('[data-ask-progress]');
  if (progress) {
    progress.hidden = !many;
    progress.textContent = many ? `Question ${state.askPage + 1} of ${pages.length}` : '';
  }
  const back = panel.querySelector('[data-ask-back]');
  const next = panel.querySelector('[data-ask-next]');
  const submit = panel.querySelector('[data-form-reply]');
  // One question keeps the old shape: no counter, no paging, just Submit.
  if (back) back.hidden = !many || state.askPage === 0;
  if (next) next.hidden = !many || state.askPage >= last;
  if (submit) submit.hidden = many && state.askPage < last;
}

export function moveAskPage(delta) {
  const panel = document.querySelector('.ask-panel');
  if (!panel) return;
  const before = state.askPage;
  state.askPage += delta;
  applyAskPage(panel);
  if (state.askPage === before) return;
  syncAskState();
  // A new question starts at its own top: a long list of options must not open
  // where the previous page happened to be scrolled to.
  const fields = panel.querySelector('.ask-fields');
  if (fields) fields.scrollTop = 0;
}

/** Conditions first, then which page that leaves, then the buttons: a `when`
 *  rule can hide the question the operator was looking at. */
export function refreshAskPanel() {
  applyAskConditions();
  applyAskPage();
  syncAskState();
}

/** Required fields, and the free-text box on a choice question, only make sense
 *  live: Next says no until this page can be answered, Submit until the whole
 *  form can. */
function syncAskState() {
  const panel = document.querySelector('.ask-panel');
  const form = currentForm();
  if (!panel || !form) return;
  const btn = panel.querySelector('[data-form-reply]');
  const next = panel.querySelector('[data-ask-next]');
  const note = panel.querySelector('[data-ask-state]');
  if (!btn) return;
  const answer = collectAskAnswer(form);
  const blank = (field) => {
    const v = answer[String(field.key ?? '')];
    return (
      v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)
    );
  };
  const missing = (form.fields || []).filter((f) => {
    if (!f.required || f.hidden || f.type === 'external') return false;
    const holder = panel.querySelector(`[data-ask-field="${CSS.escape(String(f.key ?? ''))}"]`);
    if (!holder || holder.hidden) return false;
    return blank(f);
  });
  const active = askPageList(panel, form)[state.askPage]?.field;
  const activeMissing = Boolean(active && active.required && active.type !== 'external' && blank(active));
  btn.disabled = missing.length > 0;
  if (next) next.disabled = activeMissing;
  if (note) {
    // On a page with a Next, only *this* question can block you — naming a
    // question further down the form would be a warning about something the
    // operator cannot even see yet. Submit is the one that speaks for the form.
    const text = !next || next.hidden
      ? missing.length
        ? 'Answer every required question to send.'
        : ''
      : activeMissing
        ? 'Answer this question to continue.'
        : '';
    note.textContent = text;
    note.hidden = !text;
  }
}

/** Show or hide the fields whose `when` conditions are not met yet. */
function applyAskConditions() {
  const panel = document.querySelector('.ask-panel');
  const form = currentForm();
  if (!panel || !form) return;
  const answer = collectAskAnswer(form);
  for (const holder of panel.querySelectorAll('[data-ask-when]')) {
    let ok = true;
    try {
      for (const rule of JSON.parse(holder.dataset.askWhen)) {
        const actual = answer[String(rule.key)];
        const same = String(actual) === String(rule.value);
        if (rule.op === 'eq' ? !same : same) { ok = false; break; }
      }
    } catch { /* a malformed rule hides nothing */ }
    holder.hidden = !ok;
  }
}

/** The free-text box on a choice question is only usable once its row is picked. */
export function syncAskCustoms(target) {
  const row = target.closest('.ask-opt-other');
  if (!row) return;
  const pick = row.querySelector('[data-ask-custom]');
  const text = row.querySelector('.ask-other-text');
  if (text) text.disabled = !pick?.checked;
  if (pick?.checked) text?.focus();
}

// One answer per question, however the click arrives.
//
// The ask panel is *moved into the transcript* while a question is up (mountAskPost
// does that so the question is the first thing read), so a click on Submit bubbles
// through two handlers — the panel's own and the transcript's — and both called
// this. Two POSTs went out: the first answered, the second came back "409 Form
// already settled", and the operator got an error toast above a success toast for
// one click (measured 6 Nov). The guard is the fix; the 409 is still handled, for
// the case where another window answered first.
export const replyingForms = new Set();

export async function replyForm(formId) {
  if (replyingForms.has(formId)) return;
  const form = currentForm();
  if (!form || form.id !== formId) return;
  replyingForms.add(formId);
  // The form's own session, not the open one: a worker's question is answered
  // in the session that asked it.
  const sessionId = form.sessionId || state.sessionId;
  const answer = collectAskAnswer(form);
  const btn = document.querySelector(`[data-form-reply="${CSS.escape(formId)}"]`);
  if (btn) btn.disabled = true;
  try {
    await api('POST', `/api/sessions/${encodeURIComponent(sessionId)}/forms/${encodeURIComponent(formId)}/reply`, { answer });
    state.forms = state.forms.filter((f) => f.id !== formId);
    renderAskPanel();
    // The rail's Answer mark is part of the same fact: clear it now, or it
    // outlives the question until the next poll.
    wired.renderTree();
    renderComposer();
    renderTranscript();
    toast('Answer Sent', 'The chat will carry on from it.');
  } catch (err) {
    // A question can be cancelled under us: the engine rebuilds its locations when
    // it restarts, and every pending form goes with them. Answering one that no
    // longer exists is not the operator's mistake, and leaving the dead panel up
    // means they keep pressing a button that cannot work.
    if (/Form not found/i.test(String(err.message || ''))) {
      state.forms = state.forms.filter((f) => f.id !== formId);
      renderAskPanel();
      renderComposer();
      renderTranscript();
      toast('That Question Is Gone', 'The chat was restarted and the engine cancelled it. Message it to carry on.');
      return;
    }
    // The question was settled by someone else — another window, or the
    // Auto-Answer countdown — between this page drawing it and the click. The
    // answer did not apply, but the panel must not stay up with a dead button.
    if (/already settled/i.test(String(err.message || ''))) {
      state.forms = state.forms.filter((f) => f.id !== formId);
      renderAskPanel();
      wired.renderTree();
      renderComposer();
      renderTranscript();
      toast('That Question Was Already Answered', 'It was settled a moment ago — here or in another window.');
      return;
    }
    toast('Could Not Send The Answer', err.message);
    wired.refreshPending();
  } finally {
    replyingForms.delete(formId);
  }
}
