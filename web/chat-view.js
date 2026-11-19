// The new chat's renderer: it walks the item model and draws nodes.
//
// It is deliberately dumb. Every rule — one post per turn, where a line belongs, which
// post owns the pane, which fold is open — lives in ./chat-model.js. This file turns those
// items into elements and keeps the *same element* for the same key, so an update paints
// what changed instead of replacing the conversation. That is the difference that makes a
// selection survive, a fold keep its state, and an animation possible at all.
//
// The markup reuses the styles the current chat already has (`msg`, `tool-card`,
// `trace-line`, `reasoning`, `msg-answer`), so the two renderers can be compared side by
// side with one stylesheet, and so nothing here is a second design language.
import { renderMarkdown } from './md.js';
import { roleLabel } from './run-view.js';
import { askHeadNote, answerTimeline } from './ask-note.js';
import { serverNow } from './api.js';
import { fileChip } from './format.js';
import { formatBytes, progressBar, downloadLabel } from './downloads.js';

/** HH:MM, in the operator's own 24-hour clock. */
const CLOCK = (at) => new Date(Number(at) || 0).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Whitespace collapsed: the text of a node is compared across repaints. */
const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** Two lines: the same window the chat uses for "at the end". */
const CHAT_FOLLOW_SLACK = 48;

/**
 * How long the chat's own movement lasts.
 *
 * 500ms, and one number: the operator could not tell whether an animation was missing or
 * merely quick (19 Nov), so the pause is long enough to be seen on its own. It is slow on
 * purpose for now — the judgement of it comes after the eye has found it. A page that asks
 * for reduced motion still gets none of this (`motionOff`), which is the browser's rule and
 * not a preference of ours.
 */
const MOTION_MS = 500;

const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

/** Markdown is the one place an element is filled with HTML: it is ours, and escaped first. */
function prose(text) {
  const node = el('div', 'msg-answer');
  node.innerHTML = renderMarkdown(String(text || ''));
  return node;
}

// ── lines ────────────────────────────────────────────────────────

const LINE_MARK = { compact: '⏳', loop: '↻', steer: '', note: '', waiting: '', lease: '⏱', refusal: '⛔', alarm: '⚠', error: '!' };

/** One status line, inside a post, a trace, or between them. */
function lineNode(item) {
  const p = item.props || {};
  const mark = LINE_MARK[item.line] || '';
  if (item.line === 'steer') {
    const row = el('div', `trace-line is-steer${p.pending ? ' is-pending' : ''}`);
    row.append(el('span', 'msg-steer', 'STEER:'), el('span', 'trace-steer-text', String(p.text || '')));
    for (const f of p.files || []) row.append(el('span', 'msg-file', String(f.name || '')));
    return row;
  }
  if (item.line === 'refusal') {
    const fold = document.createElement('details');
    fold.className = 'chat-alarm is-prohibited';
    fold.dataset.k = item.key;
    fold.open = Boolean(p.open);
    const summary = el('summary');
    summary.title = `PROHIBITED: ${p.action} ${(p.paths || []).join(' ')} ${p.note || ''}`.trim();
    summary.append(el('span', 'chat-alarm-mark', mark), el('span', 'chat-alarm-text', `PROHIBITED · ${p.action}${(p.paths || [])[0] ? ` · ${p.paths[0]}` : ''}`));
    const body = el('div', 'chat-alarm-body');
    for (const path of p.paths || []) body.append(el('div', 'chat-alarm-call', path));
    if (p.note) body.append(el('div', 'chat-alarm-who', p.note));
    fold.append(summary, body);
    return fold;
  }
  if (item.line === 'alarm') {
    const row = el('div', 'chat-alarm');
    row.title = `${p.what}: ${(p.paths || []).join(' | ')}${p.note ? ` — ${p.note}` : ''}`;
    row.append(el('span', 'chat-alarm-mark', mark), el('span', 'chat-alarm-text', `${p.what}${p.paths?.length ? ` · ${p.paths.join(' | ')}` : ''}`));
    return row;
  }
  if (item.line === 'error') {
    const box = el('div', 'chat-error');
    const head = el('div', 'chat-error-head');
    head.append(el('span', 'chat-error-mark', '!'), el('span', 'chat-error-title', String(p.title || 'Something failed')));
    box.append(head, el('div', 'chat-error-detail', String(p.detail || '')));
    return box;
  }
  if (item.line === 'lease') {
    const row = el('div', `chat-lease${p.expired ? ' is-expired' : ''}`);
    const clock = p.expired ? '' : ` · ${clockSpan(p.until)} left`;
    row.append(el('span', 'chat-lease-mark', mark), el('span', 'chat-lease-text', `${p.role || 'Worker'} asked for ${p.minutes || 0} minutes${clock}${p.reason ? ` · “${p.reason}”` : ''}`));
    return row;
  }
  if (item.line === 'compact') {
    const where = p.size ? ` · context at ${shortK(p.size)}${p.limit ? `/${shortK(p.limit)}` : ''}` : '';
    const row = el('div', 'trace-line is-compact');
    row.append(el('span', 'trace-mark', mark), document.createTextNode(`${p.running ? 'Compacting' : 'Compacted'} ×${p.count}${where}`));
    return row;
  }
  if (item.line === 'loop') {
    const row = el('div', 'trace-line is-loop');
    row.append(el('span', 'trace-mark', mark), document.createTextNode(`Loop detected ×${p.count} of ${p.limit}${p.count >= p.limit ? ' — marked ISSUES, next coder' : ' — asking it to carry on'}`));
    return row;
  }
  if (item.line === 'waiting') {
    const row = el('div', 'trace-line is-waiting');
    row.textContent = String(p.text || 'Working…');
    return row;
  }
  // A note, a steer without its tag, anything else: one line of text.
  const row = el('div', 'trace-line');
  row.textContent = String(p.text || '');
  return row;
}

const shortK = (n) => (!n ? '0' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const clockSpan = (until) => {
  const left = Math.max(0, Number(until) - Date.now());
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

// ── cards ────────────────────────────────────────────────────────

const STATUS_LABEL = (p) => (p.failed ? (p.exitCode !== null ? `Exit ${p.exitCode}` : 'Failed') : p.status);

function toolCard(item) {
  const p = item.props || {};
  if (p.only) {
    // A worker's tool call: the Architect's head, with no state pill and nothing to open —
    // the call is already history by the time a trace draws it (8 Nov).
    const row = el('div', 'tool-card trace-card');
    const head = el('div', 'tool-head');
    head.append(el('span', 'status-dot ok'), el('span', 'tool-name', String(p.name || 'tool')), el('span', 'tool-target', String(p.target || '')));
    row.append(head);
    return row;
  }
  const failed = Boolean(p.failed) || /error|fail/.test(String(p.status || ''));
  const running = /run|stream|pend|progress/.test(String(p.status || ''));
  const cls = running ? 'warn' : failed ? 'err' : 'ok';
  const card = el('div', `tool-card${item.open ? ' open' : ''}`);
  // What this card is showing, on the element itself: a repaint that lands after the
  // operator's own click must not animate the same opening a second time.
  card.dataset.open = String(Boolean(item.open));
  const head = el('div', 'tool-head');
  head.dataset.toolToggle = item.key;
  head.setAttribute('role', 'button');
  head.setAttribute('tabindex', '0');
  head.setAttribute('aria-expanded', String(Boolean(item.open)));
  head.append(el('span', `status-dot ${cls}`));
  head.append(el('span', 'tool-name', String(p.name || 'tool')));
  head.append(el('span', 'tool-target', targetOf(p)));
  if (p.permission) {
    const effect = String(p.permission.effect || 'allow');
    head.append(el('span', `tool-perm state-pill ${effect === 'deny' ? 'err' : p.permission.asked ? 'warn' : 'ok'}`, 'permission'));
  }
  head.append(el('span', `tool-state state-pill ${cls}`, STATUS_LABEL(p)), el('span', 'tool-chev', '›'));
  const detail = el('div', 'tool-detail');
  if (p.input !== null && p.input !== undefined) detail.append(pre(JSON.stringify(p.input, null, 1)));
  if (p.output) detail.append(pre(String(p.output), failed ? 'is-error' : ''));
  if (p.error) detail.append(pre(String(p.error), 'is-error'));
  // No `hidden`: a collapsed card keeps its body and a height of zero, so the same
  // height transition the folds use can open and close it.
  detail.style.height = item.open ? '' : '0px';
  detail.style.overflow = item.open ? '' : 'hidden';
  if (!item.open) card.classList.add('is-collapsed');
  head.addEventListener('click', () => {
    const opening = card.classList.contains('is-collapsed');
    card.dataset.open = String(Boolean(opening));
    animateDetail(card, head, detail, opening);
    viewToggle(item.key, Boolean(opening));
  });
  card.append(head, detail);
  return card;
}

/** Open or close a card's body over MOTION_MS, with reduced motion taking the short road. */
function animateDetail(card, head, detail, opening) {
  card.classList.toggle('is-collapsed', !opening);
  card.classList.toggle('open', opening);
  head.setAttribute('aria-expanded', String(opening));
  if (motionOff()) {
    detail.style.height = opening ? '' : '0px';
    detail.style.overflow = opening ? '' : 'hidden';
    return;
  }
  const start = opening ? 0 : detail.getBoundingClientRect().height;
  detail.style.overflow = 'hidden';
  detail.style.height = `${start}px`;
  const end = opening ? detail.scrollHeight : 0;
  detail.getBoundingClientRect();
  detail.style.transition = `height ${MOTION_MS}ms ease-out`;
  detail.style.height = `${end}px`;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    detail.style.transition = '';
    detail.style.height = opening ? '' : '0px';
    detail.style.overflow = opening ? '' : 'hidden';
  };
  detail.addEventListener('transitionend', done, { once: true });
  setTimeout(done, MOTION_MS + 60);
}

/**
 * The card's one line of target.
 *
 * The model words it with the same function the old chat uses (`toolTarget`), and the line
 * is clipped by the stylesheet, not by cutting the string: a command the operator wants to
 * copy out of a card has to be the whole command, and a hover shows it.
 */
function targetOf(p) {
  if (p && typeof p.target === 'string' && p.target) return p.target;
  const input = p.input && typeof p.input === 'object' ? p.input : {};
  const raw = input.command || input.path || input.filePath || input.pattern || input.query || input.url || input.name || '';
  return String(raw || p.name || '').replace(/\s+/g, ' ').trim();
}

function pre(text, cls = '') {
  const box = el('div', 'tool-body');
  const node = el('pre', cls);
  node.textContent = String(text || '');
  box.append(node);
  return box;
}

function cardNode(item) {
  if (item.card === 'tool' || item.card === 'question') return toolCard(item);
  if (item.card === 'browser') {
    const p = item.props || {};
    const failed = (p.calls || []).filter((c) => c.failed).length;
    const running = (p.calls || []).some((c) => /run|stream|pend|progress/.test(c.status));
    const cls = running ? 'warn' : failed ? 'err' : 'ok';
    const card = el('div', 'tool-card tool-group');
    const head = el('div', 'tool-head');
    head.dataset.toolToggle = item.key;
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.append(el('span', `status-dot ${cls}`), el('span', 'tool-name', 'SynaBrowse'), el('span', 'tool-target', `${(p.calls || []).length} calls`));
    head.append(el('span', `tool-state state-pill ${cls}`, running ? 'working' : failed ? `${failed} failed` : `${(p.calls || []).length} calls`), el('span', 'tool-chev', '›'));
    const detail = el('div', 'tool-detail');
    for (const call of p.calls || []) {
      const row = el('div', 'tool-group-row');
      row.append(el('span', `status-dot ${call.failed ? 'err' : 'ok'}`), el('span', 'tool-group-name', call.name), el('span', 'tool-group-target', targetOf(call)));
      detail.append(row);
    }
    detail.hidden = !item.open;
    card.append(head, detail);
    return card;
  }
  if (item.card === 'download') {
    const d = item.props || {};
    const state = String(d.state || 'inProgress');
    const done = state === 'completed';
    const bad = state === 'canceled' || state === 'interrupted';
    const card = el('div', `tool-card tool-download${done ? ' is-done' : bad ? ' is-error' : ''}`);
    card.dataset.downloadCard = String(d.id || '');
    const head = el('div', 'tool-head');
    head.append(el('span', `status-dot ${done ? 'ok' : bad ? 'err' : 'warn'}`), el('span', 'tool-name', 'SynaBrowse · Download'), el('span', 'tool-target', String(d.name || '')));
    const pct = Number(d.total) > 0 ? ` ${Math.round((Number(d.received) / Number(d.total)) * 100)}%` : '';
    head.append(el('span', `tool-state state-pill ${done ? 'ok' : bad ? 'err' : 'warn'}`, `${downloadLabel(state)}${pct}`));
    card.append(head);
    const foot = done
      ? `Saved to ${d.path || `.project/downloads/${d.name}`}`
      : bad
        ? d.error || 'The browser stopped it.'
        : 'Saving to .project/downloads';
    const size = Number(d.total) > 0 ? `${formatBytes(d.received)} / ${formatBytes(d.total)}` : formatBytes(d.received);
    const bar = el('code', 'download-bar', progressBar(d.received, d.total));
    const meta = el('div', 'download-meta', size);
    const where = el('div', 'download-foot', foot);
    where.title = foot;
    const body = el('div', 'download-body');
    body.append(el('div', 'download-name', String(d.name || '')), bar, meta, where);
    card.append(body);
    return card;
  }
  if (item.card === 'permission') {
    const p = item.props || {};
    const box = el('div', 'perm-card');
    const head = el('div', 'perm-head');
    head.append(el('span', 'status-dot warn'), el('span', 'perm-head-text', `${p.role || 'The Architect'} needs your permission`));
    box.append(head, el('pre', 'perm-res', (p.resolved?.length ? p.resolved : p.resources || []).join('\n')));
    return box;
  }
  return el('div', 'tool-card');
}

// ── folds, streams ───────────────────────────────────────────────

function foldNode(item) {
  const fold = document.createElement('details');
  const tone = String(item.tone || 'reasoning');
  fold.className = tone === 'reasoning' ? 'reasoning' : tone === 'handover' ? 'chat-post' : tone === 'refusal' ? 'chat-post is-refusal' : 'reasoning is-archive';
  fold.dataset.k = item.key;
  fold.open = Boolean(item.open);
  const summary = el('summary');
  if (item.title) summary.title = String(item.title);
  summary.textContent = String(item.tone === 'reasoning' ? `Reasoning • ${item.summary || ''}` : item.summary || '');
  fold.append(summary);
  // One wrapper, always: a fold has to have something whose height can be animated.
  const body = el('div', `fold-body${item.format === 'pre' ? ' is-pre' : ''}`);
  if (Array.isArray(item.body)) {
    const lines = el('div', 'trace-lines');
    for (const block of item.body) lines.append(blockNode(block));
    body.append(lines);
  } else if (item.format === 'pre') {
    const node = el('pre');
    node.textContent = String(item.body || '');
    body.append(node);
  } else {
    const markdown = el('div', 'chat-post-body');
    markdown.innerHTML = renderMarkdown(String(item.body || ''));
    body.append(markdown);
  }
  fold.append(body);
  return animateFold(fold, summary, body);
}

// Whether each pane is following its own end. View state: the model has no opinion about
// where the operator is looking.
const paneFollow = new Map();

// What the view does when the operator opens a card: it tells the page, and the page owns
// the state (state.open). The view never keeps the answer for itself.
let viewToggle = () => {};
// The pane's own switch: which trace it belongs to is the page's business, because the pane
// in a post is the open session's step and a pane in a trace is that worker's.
let viewPaneToggle = () => {};

/** Is the page's own motion preference off? Then every fold snaps, as the browser should. */
const motionOff = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

// Said once, in the console the app already has: a page that is told "no motion" draws no
// motion, and "I see no animations" must not be a mystery to the next person reading the log.
let motionSaid = false;
const noteMotion = () => {
  if (motionSaid || !motionOff()) return;
  motionSaid = true;
  console.info('chat: this machine asks for reduced motion, so folds, cards and arrivals do not animate');
};

/**
 * A fold that opens and closes at MOTION_MS.
 *
 * `<details>` toggles instantly: its content is not rendered while it is closed, so a height
 * transition has to be driven by hand. Opening sets `open` first and grows the body from
 * zero; closing keeps it open, shrinks the body, and sets `open` false on the last frame —
 * otherwise the content disappears before anything can move. The operator's click is still
 * a click: the `toggle` event fires at the end and the state records the fold.
 */
function animateFold(details, summary, body) {
  if (!summary || !body) return details;
  summary.addEventListener('click', (event) => {
    noteMotion();
    if (motionOff()) return;
    event.preventDefault();
    const opening = !details.open;
    const start = body.getBoundingClientRect().height;
    if (opening) details.open = true;
    body.style.overflow = 'hidden';
    body.style.height = `${start}px`;
    const end = opening ? body.scrollHeight : 0;
    // A frame between the two heights, or the browser has nothing to interpolate.
    body.getBoundingClientRect();
    body.style.transition = `height ${MOTION_MS}ms ease-out`;
    body.style.height = `${end}px`;
    // A repaint that lands in the middle of this must not put `open` back: the body is
    // still shrinking, and closing it now would take the content away before it moved.
    details._folding = true;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      details._folding = false;
      body.style.transition = '';
      body.style.height = '';
      body.style.overflow = '';
      if (!opening) details.open = false;
    };
    body.addEventListener('transitionend', done, { once: true });
    setTimeout(done, MOTION_MS + 60);
  });
  return details;
}

// ── the question panel ──────────────────────────────────────────
//
// The panel is not part of the column: it is the last thing on screen, it owns its answers,
// and a repaint must not take them away. It is built once per form and *moved* to the end
// of the list on every update; only a new form (or the same form with different fields)
// rebuilds it.

let panelNode = null;
let panelSig = '';
let panelPage = 0;
let panelClock = 0;
let submitForm = () => {};

const fieldSig = (form) =>
  `${form.id}|${form.fields.map((f) => `${f.key}:${f.type}:${f.options.map((o) => o.value).join(',')}`).join(';')}`;

const squashText = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** One field, as the control its type deserves. */
function fieldNode(field, index) {
  const name = `ask-${field.key}`;
  const box = el('div', 'ask-field');
  box.dataset.askField = field.key;
  box.dataset.askIndex = String(index);
  box.dataset.askType = field.type;
  if (field.required) box.dataset.askRequired = '1';
  if (field.when) box.dataset.askWhen = JSON.stringify(field.when);
  const showTitle = field.title && (field.title !== field.description);
  if (showTitle) box.append(el('p', 'ask-q-title', field.title));
  if (field.description) box.append(el('p', 'ask-q-text', field.description));
  if (field.required) box.append(el('span', 'ask-req', 'required'));

  const option = (kind, value, label, description, custom = false) => {
    const row = el('label', 'ask-opt');
    const input = document.createElement('input');
    input.type = kind;
    input.name = name;
    input.value = value;
    if (custom) { input.dataset.askCustom = '1'; }
    const text = el('span', 'ask-opt-text');
    text.append(el('span', 'ask-opt-label', label));
    if (description) text.append(el('span', 'ask-opt-desc', description));
    row.append(input, text);
    return row;
  };

  if (field.type === 'boolean') {
    const opts = el('div', 'ask-opts');
    opts.append(option('checkbox', 'true', field.title || 'Yes', ''));
    box.append(opts);
  } else if (field.type === 'multiselect') {
    const opts = el('div', 'ask-opts');
    for (const o of field.options) opts.append(option('checkbox', o.value, o.label, o.description));
    if (field.custom) opts.append(option('checkbox', '__custom', 'Something Else…', '', true));
    box.append(opts);
  } else if (field.options.length) {
    const opts = el('div', 'ask-opts');
    for (const o of field.options) opts.append(option('radio', o.value, o.label, o.description));
    if (field.custom) opts.append(option('radio', '__custom', 'Something Else…', '', true));
    box.append(opts);
  } else if (field.type === 'external') {
    const link = el('a', 'ask-link', field.title || field.url || 'Open');
    link.href = field.url || '#';
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    box.append(link);
  } else if (field.type === 'number' || field.type === 'integer') {
    const input = el('input', 'ask-input');
    input.type = 'number';
    input.dataset.askKey = field.key;
    if (field.minimum !== null) input.min = String(field.minimum);
    if (field.maximum !== null) input.max = String(field.maximum);
    input.value = field.default ?? '';
    box.append(input);
  } else {
    const input = el('input', 'ask-input');
    input.type = 'text';
    input.dataset.askKey = field.key;
    input.placeholder = field.placeholder || '';
    input.value = field.default ?? '';
    box.append(input);
  }
  return box;
}

/** The answers, in the shape the engine's form reply wants. */
function collectAnswers(panel, form) {
  const answer = {};
  for (const field of form.fields) {
    const holder = panel.querySelector(`[data-ask-field="${CSS.escape(field.key)}"]`);
    if (!holder || holder.hidden || holder.classList.contains('ask-page-off')) continue;
    if (field.type === 'external') continue;
    if (field.type === 'boolean') {
      answer[field.key] = Boolean(holder.querySelector('input[type="checkbox"]')?.checked);
    } else if (field.type === 'multiselect') {
      const picked = [...holder.querySelectorAll('input[type="checkbox"]:checked')]
        .filter((n) => !n.hasAttribute('data-ask-custom'))
        .map((n) => n.value);
      const other = holder.querySelector('.ask-other-text');
      if (other && other.value.trim()) picked.push(other.value.trim());
      answer[field.key] = picked;
    } else if (field.options.length) {
      const checked = holder.querySelector('input[type="radio"]:checked');
      if (!checked) continue;
      if (checked.hasAttribute('data-ask-custom')) {
        const other = holder.querySelector('.ask-other-text');
        answer[field.key] = String(other?.value || '').trim();
      } else answer[field.key] = checked.value;
    } else {
      const input = holder.querySelector('[data-ask-key]');
      answer[field.key] = field.type === 'number' || field.type === 'integer' ? (input?.value === '' ? null : Number(input.value)) : String(input?.value ?? '');
    }
  }
  return answer;
}

/** Show the current question and the right buttons for it. */
function applyPage(panel, form) {
  const holders = [...panel.querySelectorAll('.ask-field')];
  const pages = holders.filter((h) => !h.hidden);
  const last = Math.max(0, pages.length - 1);
  panelPage = Math.max(0, Math.min(panelPage, last));
  const active = pages[panelPage] || null;
  for (const holder of holders) holder.classList.toggle('ask-page-off', Boolean(active) && holder !== active);
  const many = pages.length > 1;
  const progress = panel.querySelector('[data-ask-progress]');
  if (progress) {
    progress.hidden = !many;
    progress.textContent = many ? `Question ${panelPage + 1} of ${pages.length}` : '';
  }
  const back = panel.querySelector('[data-ask-back]');
  const next = panel.querySelector('[data-ask-next]');
  const submit = panel.querySelector('[data-form-reply]');
  if (back) back.hidden = !many || panelPage === 0;
  if (next) next.hidden = !many || panelPage >= last;
  if (submit) submit.hidden = many && panelPage < last;
}

/**
 * The line beside the title: whose question it is, and how long Auto-Answer has left.
 *
 * The number is measured against the server's clock (`firstAt` comes from the server), so a
 * slow sweep or a reload does not restart it, and it is painted from a one-second interval
 * rather than from a render: a question that is waiting does not change the conversation.
 */
function paintNote(panel, form) {
  const note = panel && panel._note;
  if (!note) return;
  const auto = Boolean(form.autoAnswer);
  const left = auto && form.firstAt ? answerTimeline({ firstAt: form.firstAt, wait: form.wait, pages: form.pages, now: serverNow() }).seconds : 0;
  const text = askHeadNote({ here: Boolean(form.here), worker: Boolean(form.worker), autoAnswer: auto, seconds: left });
  if (note.textContent !== text) note.textContent = text;
}

function stopPanelClock() {
  if (panelClock) clearInterval(panelClock);
  panelClock = 0;
}

function startPanelClock(panel, form) {
  stopPanelClock();
  paintNote(panel, form);
  if (!form.autoAnswer || !form.firstAt) return;
  panelClock = setInterval(() => paintNote(panel, form), 1000);
  // A timer is not a reason for a process to stay alive.
  panelClock?.unref?.();
}

function buildForm(form) {
  const panel = el('div', 'ask-panel');
  panel.setAttribute('role', 'dialog');
  panel.dataset.ask = form.id;
  const head = el('div', 'ask-head');
  head.append(el('span', 'ask-dot'), el('span', 'ask-head-title', form.title));
  panel._note = el('span', 'ask-head-note');
  head.append(panel._note);
  const fields = el('div', 'ask-fields');
  form.fields.forEach((field, index) => fields.append(fieldNode(field, index)));
  const actions = el('div', 'ask-actions');
  const note = el('span', 'ask-state');
  const progress = el('span', 'ask-progress');
  progress.dataset.askProgress = '';
  progress.hidden = true;
  const back = el('button', 'btn btn-back btn-sm', 'Back');
  back.type = 'button';
  back.dataset.askBack = '';
  const next = el('button', 'btn btn-ask btn-sm', 'Next');
  next.type = 'button';
  next.dataset.askNext = '';
  const submit = el('button', 'btn btn-ask btn-sm', 'Submit Answer');
  submit.type = 'button';
  submit.dataset.formReply = form.id;
  actions.append(note, progress, back, next, submit);
  panel.append(head, fields, actions);
  back.onclick = () => { panelPage -= 1; applyPage(panel, form); };
  next.onclick = () => { panelPage += 1; applyPage(panel, form); };
  submit.onclick = () => submitForm({ ...form }, collectAnswers(panel, form));
  panel.addEventListener('input', () => applyPage(panel, form));
  return panel;
}

/** Mark a node as just arrived. Only a genuinely new node gets this — a repaint is not an arrival. */
function appear(node) {
  if (!node || !node.classList) return node;
  node.classList.add('is-enter');
  setTimeout(() => node.classList.remove('is-enter'), MOTION_MS + 60);
  return node;
}

/**
 * The live pane: a window of a fixed number of lines, from its first word.
 *
 * It used to grow line by line until it filled, and every line pushed the conversation down
 * while the operator was reading it. A fixed window means the words move inside the box and
 * nothing outside it moves. The text scrolls natively, so the operator can read back; the
 * pane follows only while they are at its end, and stops the moment they scroll up.
 */
const PANE_LINES = 11;
const PANE_LINE_EM = 1.45;

function streamNode(item) {
  if (item.collapsed) {
    const row = el('div', 'think-line');
    const button = el('button', 'think-toggle', 'Thinking…');
    button.type = 'button';
    button.dataset.thinkToggle = item.key;
    button.addEventListener('click', () => viewPaneToggle(item.key));
    row.append(el('span', 'status-dot live'), button);
    return row;
  }
  if (!paneFollow.has(item.key)) paneFollow.set(item.key, { follow: true });
  const wrap = el('div', 'think-wrap');
  const flow = el('div', 'trace-flow');
  // No `data-pane` on this pane, and that is on purpose: the old chat's pane code finds its
  // pane by that attribute and slides the text with a transform. This pane scrolls natively,
  // and two owners of one box is how the words end up moving twice as fast as they arrive.
  const view = el('div', 'trace-flow-view');
  // The height is set here, not only in the stylesheet: the old rule is a max-height, and a
  // max-height is exactly the growth this pane must not have.
  view.style.height = `calc(${PANE_LINES} * ${PANE_LINE_EM}em)`;
  view.style.overflowY = 'auto';
  // The words sit at the bottom of the window and grow upward, like a terminal: the newest
  // line is always the one nearest the toggle, and a short thought leaves its empty room
  // above rather than below, where the eye is going anyway.
  const inner = el('div', 'trace-flow-inner');
  inner.style.display = 'flex';
  inner.style.flexDirection = 'column';
  inner.style.justifyContent = 'flex-end';
  inner.style.minHeight = '100%';
  const body = el('div', 'trace-flow-body');
  // One text node, appended to as the words arrive. A selection inside the pane then
  // survives the next line, the same way it does inside a post.
  body.append(document.createTextNode(String(item.text || '')));
  inner.append(body);
  view.append(inner);
  flow.append(view);
  wrap.append(flow);
  // The ▾ folds the pane to its one-line "Thinking…" state. The click itself is the app's
  // (it writes the trace's collapsed flag and repaints) — the lab has no handler.
  const hint = el('button', 'think-new', 'New words ↓');
  hint.type = 'button';
  hint.hidden = true;
  hint.title = 'Jump to the newest thought';
  hint.addEventListener('click', () => {
    view.scrollTop = view.scrollHeight;
    const s = paneFollow.get(item.key) || { follow: true };
    s.follow = true;
    s.lastLen = String(item.text || '').length;
    paneFollow.set(item.key, s);
    hint.hidden = true;
  });
  wrap.append(hint);
  const toggle = el('button', 'think-toggle', '▾');
  toggle.type = 'button';
  toggle.dataset.thinkToggle = item.key;
  toggle.title = 'Hide the thinking';
  toggle.setAttribute('aria-label', 'Hide the thinking');
  toggle.addEventListener('click', () => viewPaneToggle(item.key));
  wrap.append(toggle);
  view.addEventListener('scroll', () => {
    const state = paneFollow.get(item.key) || { follow: true };
    state.follow = view.scrollHeight - view.scrollTop - view.clientHeight <= 4;
    paneFollow.set(item.key, state);
  }, { passive: true });
  fillStreamNode(wrap, item);
  return wrap;
}

/** New words in a pane that already exists: write the text, and follow only if pinned. */
function fillStreamNode(node, item) {
  const flow = node.querySelector('.trace-flow');
  const view = node.querySelector('.trace-flow-view');
  const body = node.querySelector('.trace-flow-body');
  const hint = node.querySelector('.think-new');
  // Geometry, asked before the new words are written: writing them makes the box taller,
  // and a reader at the end would look "scrolled up" a line later. This is the same
  // question the chat's own follow asks, in the same place.
  const atEnd = view ? view.scrollHeight - view.scrollTop - view.clientHeight <= 4 : true;
  const text = String(item.text || '');
  const state = paneFollow.get(item.key) || { follow: true, lastLen: 0 };
  // A pane drawn for the first time — or drawn again into a new element — starts at the top
  // of whatever it holds, which reads as "it jumped to the beginning of the reasoning" even
  // though nobody scrolled. A fresh element is not the reader having scrolled up: tail it.
  const fresh = state.node !== view;
  state.node = view;
  const grew = text.length > (Number(state.lastLen) || 0);
  state.lastLen = text.length;
  if (flow) flow.classList.toggle('is-idle', !item.live);
  if (body) {
    // The words go into the text node that is already there, and only the new tail is
    // written: assigning the whole string would drop a selection the reader made in it.
    const words = body.firstChild;
    const was = words && words.nodeType === 3 ? String(words.data || '') : null;
    if (was !== null && typeof words.appendData === 'function' && text.startsWith(was)) {
      if (text !== was) words.appendData(text.slice(was.length));
    } else if (was !== null && was === text) {
      // Already written by the node's own construction: nothing to do.
    } else if (words && words.nodeType === 3) {
      words.data = text;
    } else {
      body.textContent = text;
    }
  }
  if (view && (atEnd || fresh)) {
    view.scrollTop = view.scrollHeight;
    state.follow = true;
  } else {
    state.follow = false;
  }
  // Words arrived while the reader is scrolled up: say so, without moving their line.
  if (hint) hint.hidden = state.follow || !grew;
  paneFollow.set(item.key, state);
}

/**
 * Copy a freshly drawn node over a live one, changing as little as it can.
 *
 * Markdown is drawn as HTML, so a paragraph that gained a word arrives as a whole new
 * string. Replacing the block would take the operator's selection with it, and a selection
 * is not a nicety: it is how they copy a line out of an answer that is still being written
 * (13 Nov). Walking the two trees and writing only what changed keeps the same text nodes —
 * and a selection lives in those. An append moves nothing, so every offset in the selection
 * stays exactly where the operator put it.
 */
function reconcile(live, fresh) {
  if (!live || !fresh || live === fresh) return;
  if (live.nodeType === 3 || fresh.nodeType === 3) {
    if (live.nodeType !== fresh.nodeType) {
      live.replaceWith(fresh);
      return;
    }
    const was = String(live.data || '');
    const now = String(fresh.data || '');
    if (was === now) return;
    if (now.startsWith(was) && typeof live.appendData === 'function') live.appendData(now.slice(was.length));
    else live.data = now;
    return;
  }
  if (live.nodeType !== 1 || live.tagName !== fresh.tagName) {
    live.replaceWith(fresh);
    return;
  }
  for (const attr of [...fresh.attributes]) {
    if (live.getAttribute(attr.name) !== attr.value) live.setAttribute(attr.name, attr.value);
  }
  for (const attr of [...live.attributes]) {
    if (!fresh.hasAttribute(attr.name)) live.removeAttribute(attr.name);
  }
  // Both lists are read before anything moves: appending a child takes it out of `fresh`,
  // and a list that changes while it is walked is how a render loop skips a node.
  const want = [...fresh.childNodes];
  const have = [...live.childNodes];
  const shared = Math.min(want.length, have.length);
  for (let i = 0; i < shared; i += 1) {
    if (have[i].parentNode !== live) continue;
    reconcile(have[i], want[i]);
  }
  for (let i = shared; i < want.length; i += 1) live.appendChild(want[i]);
  while (live.childNodes.length > want.length) live.removeChild(live.lastChild);
}

/**
 * The run of children between two markers, in order, and nothing else.
 *
 * `start` and `end` are the invisible markers a post keeps around its blocks; both null means
 * the whole container, which is what a trace's own lines are. A node already in its place is
 * not touched — moving a node in the document takes the selection inside it with it, so the
 * one thing this must never do is re-insert a node that has not moved — and anything left
 * over inside the run is taken away, which is how a block that is gone stops being drawn.
 */
function place(container, nodes, start = null, end = null) {
  let node = start ? start.nextSibling : container.firstChild;
  for (const want of nodes) {
    if (node === want) {
      node = node.nextSibling;
      continue;
    }
    container.insertBefore(want, node || end || null);
    // `want` is now behind `node`, which is where the next one has to go.
  }
  while (node && node !== end) {
    const next = node.nextSibling;
    node.remove?.();
    node = next;
  }
}

/**
 * The blocks of one container, keyed.
 *
 * A block that has not changed keeps its node; a stream and a paragraph keep theirs even
 * when they have changed. For a paragraph the node is kept and only the words that arrived
 * are written into it — that is what lets a selection survive a delta. Everything else is
 * rebuilt, which is cheap and loses nothing.
 */
function fillBlocks(container, blocks, held, start = null, end = null) {
  const nodes = [];
  const seen = new Set();
  for (const [index, block] of (blocks || []).entries()) {
    // A block with no key still needs one: the nodes now live in a container that is kept
    // across repaints, so a fresh node per frame would pile up instead of replacing one.
    const key = String(block.key || `#${index}`);
    seen.add(key);
    const sig = JSON.stringify(block);
    // The same block with only its open state changed: a card can animate instead of being
    // rebuilt. A stream is handled below for the same reason.
    const base = JSON.stringify({ ...block, open: undefined });
    const prev = held.get(key);
    if (prev && prev.sig === sig) {
      nodes.push(prev.node);
      continue;
    }
    if (prev && prev.base === base && block.kind === 'card' && prev.open !== block.open) {
      // Everything but the open state is the same: keep the node and let it animate — unless
      // the operator's own click already drew this, in which case there is nothing to animate
      // and animating anyway would close it and open it again under their hand.
      if (prev.node.dataset.open === String(Boolean(block.open))) {
        held.set(key, { ...prev, sig, base, open: block.open });
        nodes.push(prev.node);
        continue;
      }
      const detail = prev.node.querySelector('.tool-detail');
      const head = prev.node.querySelector('.tool-head');
      if (detail && head) animateDetail(prev.node, head, detail, Boolean(block.open));
      held.set(key, { ...prev, sig, base, open: block.open });
      nodes.push(prev.node);
      continue;
    }
    if (prev && block.kind === 'stream') {
      // The pane has two shapes — the open window and the one-line "Thinking…" — and they
      // are different elements. Writing words into the row would draw nothing at all, which
      // is what a click on the pane's toggle used to get.
      const shape = Boolean(block.collapsed);
      const was = prev.node.classList.contains('think-line');
      if (shape === was) {
        fillStreamNode(prev.node, block);
        held.set(key, { ...prev, sig, base, collapsed: shape });
        nodes.push(prev.node);
        continue;
      }
    }
    // A paragraph that grew: the same element, with only the new words written into it.
    const wanted = block.kind === 'prose' ? (block.format === 'pre' ? 'PRE' : 'DIV') : '';
    if (prev && wanted && prev.node.tagName === wanted) {
      reconcile(prev.node, blockNode(block));
      held.set(key, { ...prev, sig, base });
      nodes.push(prev.node);
      continue;
    }
    const node = appear(blockNode(block));
    // A rebuilt block takes the place of the one it replaces. Nothing takes the old node
    // away for us: the container is kept across repaints now, so a leftover would be drawn
    // twice — once stale, once live.
    if (prev) prev.node.replaceWith(node);
    held.set(key, { node, sig, base, open: block.open });
    nodes.push(node);
  }
  for (const [key, prev] of [...held]) {
    if (seen.has(key)) continue;
    held.delete(key);
    prev.node.remove?.();
  }
  place(container, nodes, start, end);
}

function blockNode(block) {
  switch (block.kind) {
    case 'prose': {
      if (block.format === 'pre') {
        const node = el('pre', 'trace-old');
        node.textContent = String(block.text || '');
        return node;
      }
      // The operator's own words, as typed: a numbered list they wrote by hand is their
      // message, and re-lettering it into a list is not a render (19 Nov, seen at once on a
      // real conversation the moment the switch went on).
      if (block.format === 'plain') {
        const node = el('span', 'msg-text');
        node.textContent = String(block.text || '');
        return node;
      }
      const node = prose(block.text);
      if (block.answer) node.classList.add('is-answer');
      return node;
    }
    case 'fold':
      return foldNode(block);
    case 'card':
      return cardNode(block);
    case 'stream':
      return streamNode(block);
    case 'line':
      return lineNode(block);
    default:
      return el('div', 'trace-line');
  }
}

// ── posts, traces ────────────────────────────────────────────────

function fillPost(post, item) {
  post.className = `msg ${item.speaker === 'you' ? 'user' : item.speaker === 'synapse' ? 'harness' : 'assistant'}${item.steer ? ' is-steer' : ''}`;
  post.dataset.key = item.key;
  // The frame is built once and then kept: the header, two invisible comments that mark the
  // run of blocks, and the two things that come after it. A post is repainted on every
  // delta, and taking an element out of the document takes the selection inside it with it —
  // so a repaint writes into the frame and never rebuilds it.
  let body = post._body;
  if (!body) {
    body = post._body = el('div', 'msg-body');
    body._time = el('span', 'msg-time');
    body._role = el('span', 'msg-role');
    // Comments: they hold a place for the blocks without being anything the page draws,
    // says or measures. A placeholder element would take a line box and make the post two
    // pixels taller than the old chat's.
    body._start = document.createComment('words');
    body._mark = document.createComment('/words');
    body.append(body._time, body._role, body._start, body._mark);
    post.append(body);
  }
  // A worker's report says which run it came from: "Synapse · worker t1 (coder-1) completed"
  // is the header the old chat draws, and without it a report has no author.
  const speaker = item.speaker === 'you' ? 'You' : item.speaker === 'synapse' ? `Synapse · ${item.title || 'report'}` : 'Architect';
  const clock = CLOCK(item.at);
  if (body._time.textContent !== clock) body._time.textContent = clock;
  if (body._role.textContent !== speaker) body._role.textContent = speaker;
  // The steer tag is only there on a steered turn. Built when it is needed and taken away
  // when it is not: an empty span of its height still takes a line box, and that is a post
  // two pixels taller than the old chat's for no reason at all.
  if (item.steer) {
    if (!body._steer) {
      body._steer = el('span', 'msg-steer', 'STEER:');
      body.insertBefore(body._steer, body._start);
    }
  } else if (body._steer) {
    body._steer.remove();
    body._steer = null;
  }
  fillBlocks(body, item.blocks, post._blocks || (post._blocks = new Map()), body._start, body._mark);
  // What the operator attached is part of the message, not a footnote to it: the same chips
  // the old chat draws, from the one function that draws them (web/format.js). A chip keeps
  // the message and the file's index, so a picture opens from the bytes the message holds.
  if (item.speaker === 'you' && item.files && item.files.length) {
    if (!body._files) body._files = el('span', 'msg-files');
    body._files.innerHTML = item.files
      .map((f, index) => fileChip({ name: f.name, mime: f.mime }, { msgId: item.reuseId || '', index }))
      .join('');
    if (body._files.previousSibling !== body._mark) body.insertBefore(body._files, body._reuse || null);
  } else if (body._files) {
    body._files.remove();
    body._files = null;
  }
  // The operator's own message can be put back in the composer, attachments and all — after
  // the words, where the old chat puts it. Built on arrival, then kept.
  if (item.speaker === 'you' && item.reuseId) {
    if (!body._reuse) {
      const reuse = document.createElement('button');
      reuse.type = 'button';
      reuse.className = 'msg-reuse';
      reuse.title = 'Copy this message and its attachments into the composer';
      reuse.setAttribute('aria-label', 'Copy this message into the composer');
      reuse.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M3 5.4A5.2 5.2 0 1 1 3 10.6"/><path d="M3 2.6v3.2h3.2"/></svg><span>Reuse</span>';
      body._reuse = reuse;
      body.append(reuse);
    }
    body._reuse.dataset.reuseMsg = item.reuseId;
  } else if (body._reuse) {
    body._reuse.remove();
    body._reuse = null;
  }
  const error = item.error ? String(item.error) : '';
  if (error) {
    if (!body._error) {
      body._error = el('div', 'msg-error');
      body.append(body._error);
    }
    if (body._error.textContent !== error) body._error.textContent = error;
  } else if (body._error) {
    body._error.remove();
    body._error = null;
  }
}

function postNode(item) {
  const post = el('div', 'msg');
  fillPost(post, item);
  return post;
}

function fillTrace(root, item) {
  const label = roleLabel(item.role) || 'Worker';
  const rest = `${item.task ? ` · ${item.task}` : ''}${item.title ? ` · ${item.title}` : ''}`;
  const took = item.ms ? ` · ${Math.round(item.ms / 1000)}s` : '';
  const files = item.files ? ` · ${item.files} files` : '';
  const packed = item.compactions ? ` · compacted ×${item.compactions}` : '';
  const looped = item.loops ? ` · looped ×${item.loops}` : '';
  const steered = item.steered ? ' · steered' : '';
  const figures = `${took}${files}${packed}${looped}${steered}`;
  root.className = item.folded ? 'trace is-fold' : 'trace is-live';
  root.dataset.key = item.key;
  root.dataset.k = `${item.key}:fold`;
  if (item.folded) {
    if (!root._lines) {
      // Built once: the summary, the body, and the lines inside it. The role is its own
      // span, the same one the old chat styles: "CODER 1" in the trace's colour, the task
      // and the figures after it in the ordinary text colour.
      const summary = el('summary');
      const role = el('span', 'trace-role', label);
      const after = document.createTextNode('');
      summary.append(role, after);
      const body = el('div', 'fold-body');
      const lines = el('div', 'trace-lines');
      body.append(lines);
      root.replaceChildren(summary, body);
      root._summary = summary;
      root._role = role;
      root._after = after;
      root._body = body;
      root._lines = lines;
      animateFold(root, summary, body);
    }
    // Not while it is folding: the animation owns `open` until its last frame.
    if (!root._folding) root.open = Boolean(item.open);
    if (root._role.textContent !== label) root._role.textContent = label;
    if (root._after.data !== `${rest}${figures}`) root._after.data = `${rest}${figures}`;
    root._summary.title = `${label}${rest}${figures}`;
    fillBlocks(root._lines, item.blocks, root._blocks || (root._blocks = new Map()));
    return;
  }
  if (!root._lines) {
    const line = el('div', 'trace-head');
    const role = el('span', 'trace-role', label);
    const restNode = document.createTextNode('');
    line.append(role, restNode);
    const lines = el('div', 'trace-lines');
    root.replaceChildren(line, lines);
    root._head = line;
    root._role = role;
    root._rest = restNode;
    root._lines = lines;
  }
  if (root._role.textContent !== label) root._role.textContent = label;
  if (root._rest.data !== rest) root._rest.data = rest;
  const title = `${label}${rest}`;
  if (root._head.title !== title) root._head.title = title;
  fillBlocks(root._lines, item.blocks, root._blocks || (root._blocks = new Map()));
}

function itemNode(item) {
  if (item.kind === 'post') return postNode(item);
  if (item.kind === 'trace') {
    const root = document.createElement(item.folded ? 'details' : 'div');
    fillTrace(root, item);
    return root;
  }
  if (item.kind === 'line') return lineNode(item);
  if (item.kind === 'card') return cardNode(item);
  if (item.kind === 'fold') return foldNode(item);
  return el('div', 'trace-line');
}

// ── the view ─────────────────────────────────────────────────────

/**
 * Mount the chat in `host` and hand back `update(model)`.
 *
 * A node is kept for its key: an item that has not changed is not touched, one that changed
 * is repainted in place, and a node that is gone is removed. That is what makes the
 * conversation stable under a live update, and it is the whole point of the rebuild.
 */
export function createChatView(host, { onToggle, onSubmit, onPaneToggle } = {}) {
  if (typeof onToggle === 'function') viewToggle = onToggle;
  if (typeof onSubmit === 'function') submitForm = onSubmit;
  if (typeof onPaneToggle === 'function') viewPaneToggle = onPaneToggle;
  const made = new Map(); // key -> { node, sig }

  function paint(item) {
    const sig = JSON.stringify(item);
    const held = made.get(item.key);
    if (held && held.sig === sig) return held.node;
    // A post and a trace keep their element: the same node is repainted, not replaced, so
    // the thing the operator is looking at does not blink out of existence. A trace that
    // changes between live (a div) and folded (a details) has to become a new element —
    // that happens once per run, when it ends.
    const sameTag = held && (item.kind === 'post' || (item.kind === 'trace' && held.node.tagName === (item.folded ? 'DETAILS' : 'DIV')));
    let node;
    if (sameTag) {
      node = held.node;
      if (item.kind === 'post') fillPost(node, item);
      else fillTrace(node, item);
    } else {
      node = appear(itemNode(item));
      // A new element for a key that already had one: the old element goes, or the
      // conversation would show both — a live trace and its finished version, together.
      if (held) held.node.remove();
    }
    made.set(item.key, { node, sig });
    return node;
  }

  /**
   * The reader's line, captured before an update.
   *
   * The first thing visible in the box, and where it sits in the *content* (not the
   * viewport): the offset survives the box resizing, a viewport position does not. If the
   * update adds or removes anything above it, that number is what has to come back
   * unchanged -- otherwise the words slide under the operator while they read (18 Nov).
   */
  function captureAnchor() {
    const box = host.getBoundingClientRect();
    const top = box.top + 2;
    for (const node of host.querySelectorAll('.msg, .trace, .trace-line, .chat-alarm, .chat-error, .tool-card')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= top) continue;
      return {
        text: squash(node.textContent).slice(0, 40),
        offset: rect.top - box.top + host.scrollTop,
      };
    }
    return null;
  }

  /** Put it back: the same words at the same content offset, whatever moved above them. */
  function restoreAnchor(anchor) {
    if (!anchor) return;
    const box = host.getBoundingClientRect();
    for (const node of host.querySelectorAll('.msg, .trace, .trace-line, .chat-alarm, .chat-error, .tool-card')) {
      if (!squash(node.textContent).startsWith(anchor.text)) continue;
      const now = node.getBoundingClientRect().top - box.top + host.scrollTop;
      const delta = now - anchor.offset;
      if (Math.abs(delta) >= 1) host.scrollTop += delta;
      return;
    }
  }

  function update(model) {
    // At the end of the conversation the reader is following it: the box stays at the end.
    // Anywhere else they are reading, and the line they are on is the contract.
    const following = host.scrollHeight - host.scrollTop - host.clientHeight <= CHAT_FOLLOW_SLACK;
    const anchor = following ? null : captureAnchor();
    const wanted = [];
    if (model.handover) wanted.push(paint({ ...model.handover, key: 'compact-post' }));
    for (const item of model.items || []) wanted.push(paint(item));
    for (const card of model.pending || []) wanted.push(paint(card));
    // The panel is moved, never rebuilt: its answers live in its fields.
    if (model.form) {
      const sig = fieldSig(model.form);
      if (!panelNode || panelNode.dataset.sig !== sig) {
        panelNode = buildForm(model.form);
        panelNode.dataset.sig = sig;
        panelPage = 0;
        // A question arriving is the one thing in the chat that is waiting for the operator:
        // it comes in on the same motion as everything else rather than appearing mid-frame.
        appear(panelNode);
        startPanelClock(panelNode, model.form);
      }
      wanted.push(panelNode);
    } else if (panelNode) {
      panelNode.remove();
      panelNode = null;
      panelSig = '';
      stopPanelClock();
    }
    if (panelNode) {
      applyPage(panelNode, model.form);
      paintNote(panelNode, model.form);
    }

    // Put the wanted nodes in order: appendChild moves an existing node, so this both
    // orders and inserts, and it never touches a node that is already in place.
    let at = 0;
    for (const node of wanted) {
      if (host.childNodes[at] !== node) host.insertBefore(node, host.childNodes[at] || null);
      at += 1;
    }
    while (host.childNodes.length > wanted.length) host.removeChild(host.lastChild);

    // Forget the nodes that are no longer in the list.
    const live = new Set((model.items || []).map((i) => i.key).concat(model.handover ? ['compact-post'] : []));
    for (const card of model.pending || []) live.add(card.key);
    for (const key of [...made.keys()]) if (!live.has(key)) made.delete(key);

    host.classList.toggle('is-empty', wanted.length === 0);
    host.parentElement?.classList.toggle('has-history', wanted.length > 0);
    if (following) host.scrollTop = host.scrollHeight;
    else restoreAnchor(anchor);
  }

  return { update, nodes: made };
}
