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
import { formatBytes, progressBar, downloadLabel } from './downloads.js';

/** HH:MM, in the operator's own 24-hour clock. */
const CLOCK = (at) => new Date(Number(at) || 0).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Whitespace collapsed: the text of a node is compared across repaints. */
const squash = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** Two lines: the same window the chat uses for "at the end". */
const CHAT_FOLLOW_SLACK = 48;

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
  detail.hidden = !item.open;
  card.append(head, detail);
  return card;
}

function targetOf(p) {
  const input = p.input && typeof p.input === 'object' ? p.input : {};
  const raw = input.description || input.command || input.filePath || input.file_path || input.path || input.url || input.query || '';
  const text = String(raw || p.name || '').replace(/\s+/g, ' ').trim();
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
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
  if (Array.isArray(item.body)) {
    const body = el('div', 'trace-lines');
    for (const block of item.body) body.append(blockNode(block));
    fold.append(body);
  } else if (item.format === 'pre') {
    const node = el('pre');
    node.textContent = String(item.body || '');
    fold.append(node);
  } else {
    const body = el('div', 'chat-post-body');
    body.innerHTML = renderMarkdown(String(item.body || ''));
    fold.append(body);
  }
  return fold;
}

// Whether each pane is following its own end. View state: the model has no opinion about
// where the operator is looking.
const paneFollow = new Map();

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
    row.append(el('span', 'status-dot live'), button);
    return row;
  }
  if (!paneFollow.has(item.key)) paneFollow.set(item.key, { follow: true });
  const wrap = el('div', 'think-wrap');
  const flow = el('div', 'trace-flow');
  flow.dataset.pane = item.key;
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
  body.textContent = String(item.text || '');
  inner.append(body);
  view.append(inner);
  flow.append(view);
  wrap.append(flow);
  // The ▾ folds the pane to its one-line "Thinking…" state. The click itself is the app's
  // (it writes the trace's collapsed flag and repaints) — the lab has no handler.
  const toggle = el('button', 'think-toggle', '▾');
  toggle.type = 'button';
  toggle.dataset.thinkToggle = item.key;
  toggle.title = 'Hide the thinking';
  toggle.setAttribute('aria-label', 'Hide the thinking');
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
  if (flow) flow.classList.toggle('is-idle', !item.live);
  if (body) body.textContent = String(item.text || '');
  const state = paneFollow.get(item.key) || { follow: true };
  if (view && state.follow) view.scrollTop = view.scrollHeight;
}

/**
 * The blocks of one container, keyed.
 *
 * A block that has not changed keeps its node, and a stream keeps its node even when it has
 * changed: that is what lets the pane hold its scroll and its window while the words arrive.
 * Everything else is rebuilt, which is cheap and loses nothing.
 */
function fillBlocks(container, blocks, held) {
  const nodes = [];
  for (const block of blocks || []) {
    const key = String(block.key || '');
    if (!key) {
      nodes.push(blockNode(block));
      continue;
    }
    const sig = JSON.stringify(block);
    const prev = held.get(key);
    if (prev && prev.sig === sig) {
      nodes.push(prev.node);
      continue;
    }
    if (prev && block.kind === 'stream') {
      fillStreamNode(prev.node, block);
      held.set(key, { node: prev.node, sig });
      nodes.push(prev.node);
      continue;
    }
    const node = blockNode(block);
    held.set(key, { node, sig });
    nodes.push(node);
  }
  container.append(...nodes);
}

function blockNode(block) {
  switch (block.kind) {
    case 'prose': {
      if (block.format === 'pre') {
        const node = el('pre', 'trace-old');
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
  const body = el('div', 'msg-body');
  body.append(el('span', 'msg-time', CLOCK(item.at)), el('span', 'msg-role', item.speaker === 'you' ? 'You' : item.speaker === 'synapse' ? 'Synapse' : 'Architect'));
  if (item.steer) body.append(el('span', 'msg-steer', 'STEER:'));
  fillBlocks(body, item.blocks, post._blocks || (post._blocks = new Map()));
  // The operator's own message can be put back in the composer, attachments and all — after
  // the words, where the old chat puts it.
  if (item.speaker === 'you' && item.reuseId) {
    const reuse = document.createElement('button');
    reuse.type = 'button';
    reuse.className = 'msg-reuse';
    reuse.dataset.reuseMsg = item.reuseId;
    reuse.title = 'Copy this message and its attachments into the composer';
    reuse.setAttribute('aria-label', 'Copy this message into the composer');
    reuse.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 5.4A5.2 5.2 0 1 1 3 10.6"/><path d="M3 2.6v3.2h3.2"/></svg><span>Reuse</span>';
    body.append(reuse);
  }
  if (item.error) body.append(el('div', 'msg-error', String(item.error)));
  post.replaceChildren(body);
}

function postNode(item) {
  const post = el('div', 'msg');
  fillPost(post, item);
  return post;
}

function fillTrace(root, item) {
  const blocks = el('div', 'trace-lines');
  fillBlocks(blocks, item.blocks, root._blocks || (root._blocks = new Map()));
  const label = roleLabel(item.role) || 'Worker';
  const rest = `${item.task ? ` · ${item.task}` : ''}${item.title ? ` · ${item.title}` : ''}`;
  const took = item.ms ? ` · ${Math.round(item.ms / 1000)}s` : '';
  const files = item.files ? ` · ${item.files} files` : '';
  const packed = item.compactions ? ` · compacted ×${item.compactions}` : '';
  const looped = item.loops ? ` · looped ×${item.loops}` : '';
  const steered = item.steered ? ' · steered' : '';
  const head = `${label}${rest}`;
  root.className = item.folded ? 'trace is-fold' : 'trace is-live';
  root.dataset.key = item.key;
  root.dataset.k = `${item.key}:fold`;
  if (item.folded) {
    root.open = Boolean(item.open);
    const summary = el('summary');
    summary.title = `${head}${took}${files}${packed}${looped}${steered}`;
    // The role is its own span, the same one the old chat styles: "CODER 1" in the trace's
    // colour, the task and the figures after it in the ordinary text colour.
    summary.append(el('span', 'trace-role', label), document.createTextNode(`${rest}${took}${files}${packed}${looped}${steered}`));
    root.replaceChildren(summary, blocks);
    return;
  }
  const line = el('div', 'trace-head');
  line.title = head;
  line.append(el('span', 'trace-role', label), document.createTextNode(rest));
  root.replaceChildren(line, blocks);
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
export function createChatView(host) {
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
      node = itemNode(item);
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
