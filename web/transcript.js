// The conversation: one message, one tool call, one turn, turned into markup.
//
// Nothing here talks to the server or decides anything — it reads the messages the
// page already has and writes HTML. That is why it is the piece that could leave
// last: a message's parts reach into the run, the plan, the traces, the permission
// cards and the ask panel, and every one of those had to become a module of its own
// first (run-view, traces, chat-notes, chat-scroll).
//
// Five things still come from app.js, and they are the app's own business: the
// chat's height, the role cards' activity, the question post, the permission cards
// and the compact post's metadata. Wired at boot; a missing one throws.
import { state } from './state.js';
import { $ } from './dom.js';
import { esc, hhmm, toolTarget, toolFile, toolNameLabel, fileChip, shortName, reasoningGist } from './format.js';
import { renderMarkdown } from './md.js';
import { waitPostHtml } from './wait-post.js';
import { modeNoteHtml } from './mode-note.js';
import { waitingText } from './waiting.js';
import { serverNow } from './api.js';
import { permissionNote, permissionChip } from './ask-note.js';
import { alarmsHere, renderAlarm, leasesHere, renderLease, chatErrorsHere, renderChatError, leaseClock, leaseFor, callLeaseClock, leaseOfMessages } from './chat-notes.js';
import { chatAtBottom, chatFollows, scrollChatToBottom, renderChatNav, captureChatSlack, restoreStreamView } from './chat-scroll.js';
import { currentProject, roleLabel, groupTurns, currentForm } from './run-view.js';
import { renderTrace, tracesFor, traceSig, renderSessionStream } from './traces.js';
import { downloadCard, downloadsForProject, downloadsInWindow } from './downloads.js';
import { compactRow } from './compact-row.js';
import { renderRemoveChip } from './remove-exchange.js';

const missing = (name) => () => {
  throw new Error(`transcript.js: ${name} was not wired at boot`);
};
const wired = {
  renderRoleActivity: missing('renderRoleActivity'),
  mountAskPost: missing('mountAskPost'),
  renderPermissions: missing('renderPermissions'),
  compactPostOf: missing('compactPostOf'),
};

/** Hand this module the five things that live in app.js. Called once, at boot. */
export function transcriptWiring(fns) {
  Object.assign(wired, fns);
}

/** One compaction, in the same tool-shaped row a worker's trace uses. */
function compactionLine(m, line = '') {
  const running = String(m.raw?.status || '') === 'running';
  const list = state.messages || [];
  // The count is this compaction's place in the chat. The transcript normally holds
  // the message being rendered; a direct call (a test, a preview) does not, and then
  // the message is one past what the list knows.
  const counted = list.filter((x) => x.type === 'compaction' && Number(x.created) <= Number(m.created)).length;
  const inList = list.some((x) => x && m.id && x.id === m.id);
  const index = Math.max(1, inList ? counted : counted + 1);
  // The size is the compaction's own prompt — what it summarised. The step before it can
  // carry a provider's cumulative cache figure (270K on a 262K window, measured 13 Nov),
  // and a number larger than the window it filled is not a number worth printing.
  const before = [...list]
    .reverse()
    .find((x) => x.type === 'assistant' && x.raw?.tokens && Number(x.created) < Number(m.created));
  const tokens = before?.raw?.tokens || {};
  const summed = (Number(tokens.input) || 0) + (Number(tokens.cache?.read) || 0);
  const limit = wired.architectLimit?.() || 0;
  // Print the size only when it can be true. A prompt larger than the window it filled is
  // a provider's cumulative cache figure, and the compaction's own usage is sometimes the
  // summary request instead of the history (measured 13 Nov: 882 tokens on a full window).
  // No number is better than a wrong one, so the line then says only that it happened.
  const size = summed && (!limit || summed <= limit) ? summed : 0;
  return compactRow({ running, count: index, size, limit, line });
}

// ── transcript ──────────────────────────────────────────────────

/**
 * Which post the live pane belongs to: the newest Assistant turn, even when a compaction
 * line or a harness message arrived after it.
 *
 * It used to be "the last message, if it is an assistant", so a compaction line landing
 * while a turn was writing hid the pane for one render and brought it back on the next —
 * the chat moved twice for nothing, at every step (14 Nov).
 */
export function panePostIndex(showable) {
  return (showable || []).reduce((at, m, i) => (m?.type === 'assistant' ? i : at), -1);
}

/**
 * Where a merged Assistant turn must be split so an alarm stays put.
 *
 * The engine sends one message per step and the transcript merges the steps of a turn
 * into one block. An alarm (a PROHIBITED refusal) that arrived between two steps was
 * therefore rendered after the whole turn — and as the turn kept growing, it slid down
 * with it and stayed at the bottom of the chat (15 Nov). The first Assistant message at
 * or after the alarm is the step that follows it; the merge stops there, so the line
 * sits where it happened.
 */
export function alarmBreaks(messages, alarmTimes = []) {
  const breaks = new Set();
  for (const at of alarmTimes || []) {
    if (!at) continue;
    const hit = (messages || []).find((m) => m?.type === 'assistant' && (Number(m.created) || 0) >= at);
    if (hit?.id) breaks.add(hit.id);
  }
  return breaks;
}

/**
 * Is the operator holding a selection inside the conversation?
 *
 * A selection is a reader's work in progress, and this renderer replaces the whole
 * conversation: the range dies with the nodes. Live turns rebuild on every reasoning
 * delta, so a selection could not survive a second — the operator could not select a
 * sentence to copy it (18 Nov). While one is held the render waits (state.renderPaused),
 * and app.js catches the chat up when it is released.
 */
export function selectionInChat() {
  const box = $('transcript');
  const sel = window.getSelection?.();
  if (!box || !sel || sel.isCollapsed || !sel.rangeCount) return false;
  const node = sel.getRangeAt(0).commonAncestorContainer;
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return Boolean(el && box.contains(el));
}

// One render may ignore a held selection. The question panel uses it: a question
// arriving is a stronger event than a selection, and its placement needs the report in
// the DOM before it can be put under it.
let renderOnce = false;

// One catch-up draw after an animation has let go of the markup (see renderTranscript).
let holdCatchUp = 0;

/** Let the next render replace the conversation even if a selection is in it. */
export function forceNextRender() {
  renderOnce = true;
}

// ── a line that arrives ─────────────────────────────────────────
//
// The conversation is rebuilt from one HTML string on every delta, so a new reasoning
// block, a tool card or a whole post is a brand-new element each time: the browser has
// nothing to animate, and the line simply exists between two frames — the "abrupt
// 1-frame update" the operator reported (20 Nov).
//
// The renderer is the one thing that knows which rows are new, because every row that
// can arrive carries its own name (`lineKey`). It hands that one fact to the stylesheet,
// which slides the row into place in 200ms. Nothing here decides what a row looks like.
//
// A row that is rebuilt while it is still sliding must not start again. The negative
// `animation-delay` is how far into its own slide it already is, so the next render —
// a delta, milliseconds later — continues the movement instead of restarting it.

const ARRIVE_MS = 200;

// More than this many new rows in one draw is not one thing happening: it is a chat
// catching up (a replayed turn, a reload that replaced the local echo). Those rows
// appear as they are, without a wave of fading lines.
const ARRIVE_MAX = 8;

/** The rows that can arrive. A row with none of these names is part of another row. */
const ROWS =
  '[data-line], [data-trace], [data-tool-card], [data-download-card], [data-wait-post], ' +
  'details.reasoning[data-k], details.chat-post[data-k], details.chat-alarm[data-k]';

/** When each row on screen first arrived, for as long as its slide lasts. */
const arrivedAt = new Map();

/** The chat the conversation on screen belongs to. Opening another is not an arrival. */
let drawnFor = '';

/** The name a row travels under: its post, its part, its trace, its card. */
export function lineKey(node) {
  const data = node?.dataset || {};
  if (data.line) return `line:${data.line}`;
  if (data.trace) return `trace:${data.trace}`;
  if (data.toolCard) return `tool:${data.toolCard}`;
  if (data.downloadCard) return `file:${data.downloadCard}`;
  if (data.waitPost !== undefined) return 'wait-post';
  if (data.k) return `fold:${data.k}`;
  return '';
}

/**
 * Which rows are new in this draw, and how far into their slide they are.
 *
 * `before` is the row names the page had, in document order. A row that arrives inside
 * a new row — a tool card in a brand-new post — is not an arrival of its own: the post's
 * slide carries it, and two slides on one block read as a shake.
 *
 * A new name standing where an old name was, at the same place in the list, is the same
 * row under a new name — the page's own echo replaced by the engine's message, or the
 * post it opened for a turn replaced by the turn itself. It keeps the slide it already
 * had, or none if it was settled: otherwise the operator's own sentence would dip twice.
 *
 * Exported because this is the whole decision; the DOM part only applies its answer.
 */
export function planArrivals(rows, before, now) {
  const seen = new Set(before);
  const current = new Set(rows.map((row) => row.key));
  const fresh = [];
  rows.forEach((row, i) => {
    if (seen.has(row.key) || arrivedAt.has(row.key)) return;
    if (row.holder && !seen.has(row.holder)) return;
    const was = before[i];
    if (was && !current.has(was)) {
      const at = arrivedAt.get(was);
      // The row that was here is gone and this one took its place: it is that row
      // continuing. If it had finished its slide, it does not start another.
      if (at !== undefined) arrivedAt.set(row.key, at);
      return;
    }
    fresh.push(row.key);
  });
  if (fresh.length <= ARRIVE_MAX) {
    for (const key of fresh) arrivedAt.set(key, now);
  }
  const plan = new Map();
  for (const row of rows) {
    const at = arrivedAt.get(row.key);
    if (at === undefined) continue;
    const age = now - at;
    if (age >= ARRIVE_MS) {
      arrivedAt.delete(row.key);
      continue;
    }
    plan.set(row.key, age);
  }
  // A row that left the screen mid-slide is not coming back.
  for (const [key, at] of arrivedAt) if (now - at >= ARRIVE_MS) arrivedAt.delete(key);
  return plan;
}

/** Hand the new rows to the stylesheet, with their slide's head start. */
function arrive(el, before, firstDraw) {
  // Opening a chat is the conversation, not one line arriving in it.
  if (firstDraw) return;
  const rows = [];
  for (const node of el.querySelectorAll(ROWS)) {
    const key = lineKey(node);
    if (!key) continue;
    const holder = node.parentElement?.closest(ROWS);
    rows.push({ node, key, holder: holder ? lineKey(holder) : '' });
  }
  const now = Date.now();
  const plan = planArrivals(rows, before, now);
  for (const row of rows) {
    const age = plan.get(row.key);
    if (age === undefined) continue;
    row.node.style.animationDelay = `-${Math.round(age)}ms`;
    row.node.classList.add('is-arriving');
  }
}

export function renderTranscript() {
  const el = $('transcript');
  if (!el) return;
  // A fold or the thinking pane is opening or closing, and the animation owns the markup for
  // a quarter of a second. Drawing now would replace the element mid-move — which is what
  // made a fold impossible to close while the pane was being written to: every delta drew
  // the fold back to its old state. The pane's own words do not need a redraw (its own frame
  // loop writes them), so nothing stalls while this waits.
  const holdUntil = Number(state.renderHoldUntil) || 0;
  if (holdUntil > Date.now()) {
    if (!holdCatchUp) {
      holdCatchUp = setTimeout(() => {
        holdCatchUp = 0;
        renderTranscript();
      }, holdUntil - Date.now() + 16);
    }
    return;
  }
  if (!renderOnce && selectionInChat()) {
    state.renderPaused = true;
    state.heldDraws = (Number(state.heldDraws) || 0) + 1;
    wired.onPause?.();
    return;
  }
  renderOnce = false;
  state.renderPaused = false;
  state.heldDraws = 0;
  toolSeq = 0;
  // Read the reader's intent BEFORE anything below can move the box. A dock that
  // shrinks makes the transcript look "scrolled up" even though nobody moved —
  // which is why new reasoning and tool lines once arrived without the chat
  // following them.
  //
  // And then follow only if the reader was already at the end. This used to stick
  // unconditionally while a turn was running, which meant a report arriving under
  // a worker's trace dragged the page down while the operator was reading an old
  // message. Being pulled away from what you are reading is worse than missing
  // the end of a long turn: the scroll button and the rail already say something
  // arrived.
  //
  // And a render obeys the same hand-off as the frame loop: `chatAtBottom()` alone is
  // geometry, and geometry is exactly what the pin keeps true. While the thinking pane
  // grows, a render that re-pinned on it put the box back at the end a moment after
  // the reader had scrolled away — one wheel notch lost the fight and only spamming
  // the wheel got out (10 Nov, third report). `chatFollows()` is the reader's answer.
  const stick = chatAtBottom() && chatFollows();
  // The Architect's card shows what its own turn is doing, read from this same
  // transcript, so it is refreshed wherever the transcript is.
  wired.renderRoleActivity();
  // The delete chip is about this transcript's last exchange, and its availability
  // arrives with the messages. It is hidden while anything is live.
  renderRemoveChip();
  // Only the conversation itself is shown: user turns, assistant turns, and the
  // harness speaking (a worker's report being handed back). Anything else the
  // engine reports (system prompts, scaffolding, context dumps) is not chat and
  // once leaked into the transcript above the user's own message. Errors still
  // show, whatever type carries them.
  //
  // Every part carries a stable key (its message id + index) so an expanded
  // Reasoning block or tool card can be restored after a rebuild — a poll
  // landing mid-read used to snap them shut.
  // A prohibited refusal is one entry, and the alarm is it: the alarm carries the
  // tool and the target and folds open for the rest. The harness message that
  // follows said the same thing in a paragraph, so it is dropped when an alarm
  // covers it — within a few seconds of it (12 Nov).
  const refusals = alarmsHere()
    .filter((a) => a.prohibited)
    .map((a) => Number(a.at) || 0);
  const tagged = state.messages
    .filter((m) => {
      // A compaction the operator stopped is not a failure to read: the chip and
      // the toast already said "cancelled", and the engine's own message would
      // otherwise appear as a red "COMPACTION" block in the chat.
      if (m.type === 'compaction' && /cancell?ed/i.test(String(m.error || ''))) return false;
      // A compaction is part of the conversation's history, not scaffolding: the
      // operator asked why the context dropped and the chat said nothing (12 Nov).
      // A cancelled one is the exception — the toast and the chip already said so.
      if (m.type === 'compaction') return Boolean(m.raw?.status);
      if (String(m.description || '').trim().toUpperCase() === 'PROHIBITED') {
        const at = Number(m.created) || 0;
        if (refusals.some((covered) => Math.abs(covered - at) <= 15000)) return false;
      }
      return m.error || m.type === 'user' || m.type === 'assistant' || m.type === 'synthetic';
    })
    .map((m) => (m.parts ? { ...m, parts: m.parts.map((p, i) => ({ ...p, _k: `${m.id}:${i}` })) } : m));
  const showable = groupTurns(tagged, { breakBefore: alarmBreaks(tagged, refusals) });
  // The posts the delete chip would take: the last operator prompt and every post
  // after it. The server names the boundary, so the page never guesses which user
  // message is the last exchange.
  const removeFrom = state.removeInfo?.available
    ? showable.reduce((at, m, i) => (m.type === 'user' && m.id === state.removeInfo.messageID ? i : at), -1)
    : -1;
  // Only permissions stay in the transcript: a form is answered in the panel
  // over the chat, and a card here would both duplicate it and change the
  // transcript's height the moment it appeared.
  const pending = wired.renderPermissions();
  // A turn queued for a busy local server is a post of its own, drawn from the
  // server's queue so it survives a switch and a reload (20 Nov).
  const waitPost = waitPostHtml(state.lease);
  // A mode switch with a persona leaves one harness note at the end of the chat;
  // it is not a message and it is not sent to the model.
  const modeNote = modeNoteHtml();
  // The post a compact left: the only thing the new chat starts with. It is not
  // a message — no speaker — and it comes from this chat's own metadata, so it
  // survives a reload and is gone when the next compact replaces the chat.
  const compactPost = wired.compactPostOf();
  const postHtml = compactPost ? compactPostHtml(compactPost) : '';
  // A question needs room even when the conversation is empty: the panel is the
  // dock's own child and takes its height from the dock, so a freshly opened
  // session (a strip of composer) would show a 64px form with its buttons
  // hanging outside it. A form is something to read, so the dock opens for it.
  const downloads = downloadsForProject();
  const hasHistory =
    showable.length > 0 || Boolean(postHtml) || Boolean(modeNote) || Boolean(pending) || Boolean(waitPost) || Boolean(currentForm()) || alarmsHere().length > 0 || downloads.length > 0;
  // The dock is a bare composer while empty and fills the stage once there is
  // anything to show; the CSS keys off this class, so set it on every render.
  $('chatDock')?.classList.toggle('has-history', hasHistory);
  // An empty dock sits at the bottom of the page, a full one starts under the
  // cards — so the room left for it has to be re-measured on every change.

  // Nothing in the conversation changed since the last render: leave the DOM —
  // and whatever the operator has open — exactly as it is.
  //
  // A part *count* is not the same as "nothing changed". The Architect's report is
  // text inside a part that already exists, so a message that grew kept the same
  // signature and was never redrawn: on 18 Nov a question panel opened over a chat
  // whose report had not been fetched yet, the report arrived a moment later, and it
  // stayed invisible until something else moved. Only a live message is measured —
  // a finished one's text cannot change, and the length is what the check is for.
  const messageSig = (m) => {
    const live = m.type === 'assistant' && !m.completed;
    return (m.parts || [])
      .map((p) => `${p.type}${live && p.type === 'text' ? `:${String(p.text || '').length}` : ''}${p.status ? `.${p.status}` : ''}`)
      .join(',');
  };
  const sig = hasHistory
    ? `${showable.map((m) => `${m.id}:${m.completed || 0}:${messageSig(m)}`).join(',')}|${pending.length}|${modeNote ? state.modeNote?.at || 1 : 0}|${waitPost ? 1 : 0}|${state.streaming}|${traceSig()}|${alarmsHere().length}|${state.decisionSeq}|${state.downloadSeq}|${
        compactPost ? `${compactPost.at}:${compactPost.summary.length}` : ''
      }`
    : '';
  if (sig && sig === state.renderSig) {
    renderChatNav();
    return;
  }
  state.renderSig = sig;

  if (!hasHistory) {
    // nothing to show: collapse the transcript entirely, so the dock is just
    // the composer and the empty space above it belongs to the cards/napkin
    el.innerHTML = '';
    el.classList.add('is-empty');
    // The next thing drawn in this chat is a beginning, not an arrival.
    drawnFor = '';
    renderChatNav();
    return;
  }
  el.classList.remove('is-empty');
  // The conversation, with each worker's trace where it happened: a run that
  // started at 19:45 belongs above the report that arrives at 19:54, not under
  // it. A *live* trace is the exception: it is the newest thing happening, and
  // the operator watching the end of the chat must see it there. It used to stay
  // at its start, so a deferral or an acknowledgement that arrived mid-run pushed
  // the live thinking up to third-from-last. When it reports, it settles back to
  // its start. Alarms are merged by time for the same reason: a line *in* the
  // conversation scrolls up with the rest of it instead of standing at the bottom.
  const items = [
    ...tracesFor(currentProject()?.directory).map((t) => ({
      at: t.finishedAt ? Number(t.startedAt) || 0 : Number.MAX_SAFE_INTEGER,
      html: renderTrace(t),
    })),
    ...alarmsHere().map((a) => ({ at: Number(a.at) || 0, html: renderAlarm(a) })),
    ...chatErrorsHere().map((e) => ({ at: Number(e.at) || 0, html: renderChatError(e) })),
  ].sort((x, y) => x.at - y.at);
  let html = postHtml;
  let next = 0;
  // The live step belongs to the newest assistant message, inside its own green
  // rule — not to the transcript after it (2 Nov: the operator saw a second grey
  // block with its own head and gap, reading as somebody else's post).
  //
  // "Newest assistant" is not "the last message": a compaction line or a harness
  // message can arrive while a turn is still writing, and the pane used to drop out
  // for that render and come back on the next one — one of the two jumps the operator
  // watched at every step (14 Nov).
  const liveTail = renderSessionStream();
  const paneAt = panePostIndex(showable);
  // A compaction message arrives while the pane is still open, and it is created
  // after the assistant step it belongs to — so drawing it in message order put it
  // *under* the thinking pane until the next step pushed it up. It belongs above the
  // pane. Move the compaction messages that immediately follow the pane's post into
  // that post's tail, before the pane; they keep that place when the turn ends, so
  // the line does not jump down when the pane goes away.
  const movedCompactions = new Set();
  let paneTail = liveTail;
  if (paneAt >= 0) {
    const lines = [];
    for (let j = paneAt + 1; j < showable.length; j += 1) {
      const next = showable[j];
      if (next?.type !== 'compaction') break;
      movedCompactions.add(next);
      lines.push(compactionLine(next, next.id ? ` data-line="msg:${esc(next.id)}"` : ''));
    }
    if (lines.length) paneTail = lines.join('') + liveTail;
  }
  // A download belongs to the post it happened in: inside that post's green rule, and
  // scrolling with it (18 Nov). Live cards carry MAX_SAFE_INTEGER, so they land in the
  // newest post; anything that fits no post (a chat with no assistant message yet) is
  // appended after the conversation.
  const placedDownloads = new Set();
  for (let i = 0; i < showable.length; i += 1) {
    const m = showable[i];
    const at = Number(m.created) || 0;
    while (next < items.length && at && items[next].at < at) html += items[next++].html;
    let extras = '';
    if (m.type === 'assistant' && downloads.length) {
      const until = Number(showable[i + 1]?.created) || Number.POSITIVE_INFINITY;
      const mine = downloadsInWindow(downloads, at, until).filter((d) => !placedDownloads.has(d.id));
      if (mine.length) {
        mine.forEach((d) => placedDownloads.add(d.id));
        extras = mine.map(downloadCard).join('');
      }
    }
    if (!movedCompactions.has(m)) html += renderMessage(m, i === paneAt ? paneTail : '', extras, removeFrom >= 0 && i >= removeFrom);
  }
  while (next < items.length) html += items[next++].html;
  if (liveTail && paneAt === -1) html += liveTail;
  const orphanDownloads = downloads.filter((d) => !placedDownloads.has(d.id)).map(downloadCard).join('');
  html += orphanDownloads;
  // A lease that belongs to a run still on this page is drawn in that run's trace, beside its
  // thinking; the line is for a lease whose run has folded or is not here at all (21 Nov).
  const liveRuns = new Set(
    tracesFor(currentProject()?.directory)
      .filter((t) => !t.finishedAt)
      .map((t) => String(t.task || '')),
  );
  html += leasesHere()
    .filter((lease) => !liveRuns.has(String(lease.task || '')))
    .map(renderLease)
    .join('');
  // What is on screen now, read before the draw replaces it: a row whose name is not
  // in here is a row that just arrived ("a line that arrives", above).
  const seenRows = [];
  for (const node of el.querySelectorAll(ROWS)) {
    const key = lineKey(node);
    if (key) seenRows.push(key);
  }
  const chat = String(currentProject()?.directory || '');
  const firstDraw = chat !== drawnFor;
  drawnFor = chat;
  el.innerHTML = html + modeNote + waitPost + pending;
  arrive(el, seenRows, firstDraw);
  // The live panel's slide is a transform on a node this rebuild just replaced, so
  // the offset has to be put back or the text snaps to its first line.
  restoreStreamView();
  // The question is the conversation's last post, not an overlay over it.
  wired.mountAskPost();
  if (stick) scrollChatToBottom();
  // New lines change the distance to the end, not the place the reader is reading:
  // measure again now that they are laid out, so a box that changes size later
  // holds these words still rather than the old ones.
  captureChatSlack();
  renderChatNav();
}

// The role label shares the first line with the text; the time rides the right.
export function renderMessage(m, tail = '', extras = '', remove = false) {
  const t = hhmm(m.created);
  const stamp = t ? `<span class="msg-time">${t}</span>` : '';
  // The name this post travels under while it slides in. Every message the page draws
  // has an id — the engine's, or the `local-` one an echo carries until the reload.
  const line = m.id ? ` data-line="msg:${esc(m.id)}"` : '';
  // The delete chip highlights the posts it would remove; this is the only hook the
  // hover and confirmation need.
  const taken = remove ? ' is-remove-target' : '';
  const takenAttr = remove ? ' data-remove-target="1"' : '';

  // A harness steer is a real user-role turn — the engine has no synthetic role for a
  // mid-turn prompt — but it is Synapse speaking, not the operator. Draw it with the
  // standard harness post, never as "You" (22 Nov).
  if (m.type === 'user' && /^\s*\[harness\]/i.test(String(m.text || ''))) {
    const body = String(m.text || '').replace(/^\s*\[harness\]\s*/i, '');
    return `<div class="msg harness${taken}"${line}${takenAttr} data-msg="synapse"><div class="msg-body">
      ${stamp}<span class="msg-role">Synapse · harness</span>
      <div class="msg-answer">${renderMarkdown(body)}</div>
    </div></div>`;
  }
  if (m.type === 'user') {
    // What was attached is part of the message, not a footnote to it: the operator
    // asked about a file, and a transcript that shows the sentence and hides the
    // file cannot be read later.
    const files = Array.isArray(m.files) ? m.files : [];
    // One chip, drawn by the one function that draws chips (web/format.js), so a
    // message, a model's answer and a steer cannot drift apart. A picture is a chip
    // only when the bytes are still on the message: `attachmentImage` is the test.
    const chips = files.length
      ? `<span class="msg-files">${files
          .map((f, index) => fileChip(f, { msgId: attachmentImage(m, index) ? m.id : '', index }))
          .join('')}</span>`
      : '';
    // A sent message can become a new one: this puts its words and attachments
    // back in the composer, where it can be edited before it is sent again. The
    // bytes are on the raw message the engine kept; a local echo carries them on
    // `_files` until the reload replaces it.
    const reuse = m.id
      ? `<button type="button" class="msg-reuse" data-reuse-msg="${esc(m.id)}"
           title="Copy this message and its attachments into the composer"
           aria-label="Copy this message into the composer">
           <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"
                stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
             <path d="M3 5.4A5.2 5.2 0 1 1 3 10.6"/><path d="M3 2.6v3.2h3.2"/>
           </svg><span>Reuse</span></button>`
      : '';
    // A steer is the operator speaking while the turn runs. The engine keeps the
    // marker so the model knows what it is; the operator sees the same purple
    // "You" with a yellow STEER: prefix, so the difference is visible at a glance.
    const steer = String(m.text || '').match(/^\[steer\]\s*([\s\S]*)$/);
    const said = steer ? steer[1] : m.text;
    // The tag lives at the start of the sentence, not in the header: it belongs to
    // the words. A purple dot breathes beside it while the steer has not been read —
    // the same "something is happening" mark a compaction gets, in the operator's
    // own colour (26 Nov).
    const pending = m.pending ? ' is-pending' : '';
    const dot = steer && m.pending ? '<span class="steer-dot" aria-hidden="true"></span>' : '';
    const lead = steer ? `${dot}<span class="msg-steer">STEER:</span> ` : '';
    // The speaker is its own line, the way Architect and Synapse are. The old row
    // put "You" and the sentence on one baseline, which was a vertical-alignment
    // problem with no right answer at every chat size (26 Nov).
    return `<div class="msg user${steer ? ' is-steer' : ''}${pending}${taken}"${line}${takenAttr} data-msg="user"><div class="msg-body">
      <div class="msg-head"><span class="msg-role">You</span><span class="msg-head-right">${reuse}${stamp}</span></div>
      <div class="msg-text">${lead}${esc(said)}</div>${chips}
    </div></div>`;
  }
  if (m.type === 'synthetic') {
    // Synapse speaking: a worker's report, or something the harness needs the
    // Architect to know. Identical block to the Architect's and the operator's —
    // same header, same rule down the left — in Synapse's own colour.
    //
    // The leading "[harness]" is stripped because the header already names the
    // speaker. Reports written before that was true are still in the transcript,
    // so this is done here rather than only at the source.
    const label = m.description ? esc(m.description) : 'report';
    const body = String(m.text || '').replace(/^\s*\[harness\]\s*/i, '');
    // A PROHIBITED refusal is the one harness line in red: the operator's protected
    // list said no to a change, which is an alarm, not a report (4 Nov).
    const prohibited = String(m.description || '').trim().toUpperCase() === 'PROHIBITED';
    const cls = `msg harness${prohibited ? ' is-prohibited' : ''}`;
    // The engine announces every file it loads as an instruction and posts the whole
    // text with it — `android\AGENTS.md` ran to a hundred lines and buried the new
    // chat the moment it was compacted. The content is in the model's context either
    // way, so the chat keeps one line and the text behind it (1 Nov).
    if (/^loaded\s/i.test(String(m.description || '')) && /^instructions from:/i.test(body)) {
      const nl = body.indexOf('\n');
      const head = nl === -1 ? body : body.slice(0, nl);
      const rest = nl === -1 ? '' : body.slice(nl + 1).replace(/^\s+/, '');
      // "Instructions from: F:\dev\...\android\AGENTS.md" is a path, and a path at the
      // head of a line pushes the chevron off the edge. The file's last two parts name
      // it, and the full path is one hover away.
      const full = String(/^instructions from:\s*(.*)$/i.exec(head)?.[1] || '').trim();
      const short = full.split(/[\\/]/).filter(Boolean).slice(-2).join('\\') || full;
      const key = `loaded:${m.id}`;
      return `<div class="msg harness${taken}"${line}${takenAttr} data-msg="synapse"><div class="msg-body">
        ${stamp}<span class="msg-role">Synapse · ${label}</span>
        <details class="chat-post" data-k="${esc(key)}"${state.open.has(key) ? ' open' : ''}>
          <summary><span class="chat-post-note" title="${esc(full)}">Instructions from ${esc(short)}</span></summary>
          <div class="chat-post-body" data-fold-body>${renderMarkdown(rest)}</div>
        </details>
      </div></div>`;
    }
    // A refusal is one line, not a paragraph. The rule behind it ("do not try another
    // tool …") is the model's instruction; the operator needs the fact, and the
    // sentence is one click away. Measured 12 Nov: a refused command filled three
    // lines of the chat before this.
    if (prohibited) {
      const key = `refused:${m.id}`;
      const sentence = String(body || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
      return `<div class="${cls}${taken}"${line}${takenAttr} data-msg="synapse"><div class="msg-body">
        ${stamp}<span class="msg-role">Synapse</span>
        <details class="chat-post is-refusal" data-k="${esc(key)}"${state.open.has(key) ? ' open' : ''}>
          <summary title="${esc(sentence)}"><span class="chat-post-note">⛔ PROHIBITED · the protected list refused this change</span></summary>
          <div class="chat-post-body" data-fold-body>${esc(String(body || ''))}</div>
        </details>
      </div></div>`;
    }
    return `<div class="${cls}${taken}"${line}${takenAttr} data-msg="synapse"><div class="msg-body">
      ${stamp}<span class="msg-role">Synapse · ${label}</span>
      <div class="msg-answer">${renderMarkdown(body)}</div>
    </div></div>`;
  }
  if (m.type === 'compaction') {
    return `<div class="trace is-compact-post${taken}"${line}${takenAttr} data-msg="synapse"><div class="trace-lines">` +
      `${compactionLine(m)}</div></div>`;
  }
  if (m.type === 'assistant') {
    const body = [`${stamp}<span class="msg-role">Architect</span>`];
    const parts = m.parts || [];
    // The page's own live post is not the only empty post a turn can have: the
    // engine creates its assistant message before it has any parts, and a poll
    // can replace the page's post with it. An unfinished empty message is the
    // same moment, so it wears the same waiting line instead of a bare ellipsis.
    const waitingHere = m.live || (m.completed === false && !tail);
    // The last text of a message that has no tool calls is the answer: it gets
    // the green rule down its left, so prose is one glance away from the
    // reasoning and tool cards above it. Narration in a step that also calls a
    // tool stays plain — that is work, not the answer.
    const lastText = parts.map((p, i) => (p.type === 'text' ? i : -1)).filter((i) => i >= 0).pop();
    // A turn is grouped into one message, so "was there work?" is a question
    // about the parts before the last text, not about a separate message. Text
    // followed by a tool is narration; text after the work is the answer.
    const workBefore =
      lastText !== undefined &&
      parts.slice(0, lastText).some((p) => p.type === 'reasoning' || p.type === 'tool');
    const toolAfter = lastText !== undefined && parts.slice(lastText + 1).some((p) => p.type === 'tool');
    // A long turn is forty reasoning blocks — one per step — and a fold each reads
    // as a wall. The newest ten keep their own folds (the operator watched that
    // thinking arrive, and ten is about a screenful of work), and everything older
    // is one fold that opens, the same shape the worker trace uses for its older
    // steps. Each fold carries its first sentence, so the line says what the block
    // was about instead of only that it exists (8 Nov).
    const REASONING_KEEP = 10;
    // A reasoning part with no text is a step that has not thought yet: the engine
    // opens the part before the first token, and it sat in the chat as an empty fold
    // labelled "Reasoning" while the tools ran (8 Nov). Empty parts are not folds.
    const reasoningAt = parts
      .map((p, i) => (p.type === 'reasoning' && String(p.text || '').trim() ? i : -1))
      .filter((i) => i >= 0);
    const olderReasoning = (reasoningAt.length > REASONING_KEEP ? reasoningAt.slice(0, -REASONING_KEEP) : [])
      // A fold the operator has open is never archived, however old it gets: the archive is
      // one closed fold, so rolling an open one into it is the chat shutting something the
      // operator was reading (reported twice, 18 Nov and again 19 Nov). It stays out until
      // they close it, or until the turn ends and the page closes every reasoning fold.
      .filter((n) => !state.open.has(parts[n]._k));
    const recentReasoning = new Set(reasoningAt.slice(-REASONING_KEEP));
    const archiveKey = `reasoning:${m.id}`;
    for (const [i, part] of parts.entries()) {
      // The model's actual answer goes in its own panel, rendered as markdown,
      // so it is visually separate from reasoning and tool noise. The separator
      // only exists when there was work in this turn to separate it from.
      if (part.type === 'text') {
        const answer = i === lastText && workBefore && !toolAfter ? ' is-answer' : '';
        const name = part._k ? ` data-line="part:${esc(part._k)}"` : '';
        body.push(`<div class="msg-answer${answer}"${name}>${renderMarkdown(part.text)}</div>`);
      }
      else if (part.type === 'reasoning') {
        // The archive takes the place of the oldest block, so the turn still reads
        // in order: the early thinking folded, the recent thinking where it happened.
        if (i === olderReasoning[0]) {
          body.push(
            `<details class="reasoning is-archive" data-k="${esc(archiveKey)}"${state.open.has(archiveKey) ? ' open' : ''}>` +
              `<summary>${olderReasoning.length} earlier reasoning</summary>` +
              `<div class="fold-wrap" data-fold-body>${olderReasoning.map((n) => `<pre>${esc(parts[n].text)}</pre>`).join('')}</div>` +
              `</details>`,
          );
        } else if (recentReasoning.has(i) || state.open.has(part._k)) {
          body.push(
            `<details class="reasoning" data-k="${esc(part._k)}" data-line="part:${esc(part._k)}"${state.open.has(part._k) ? ' open' : ''}>` +
              `<summary>${esc(reasoningGist(part.text))}</summary>` +
              `<div class="fold-wrap" data-fold-body><pre>${esc(part.text)}</pre></div></details>`,
          );
        }
      }
      else if (part.type === 'tool') {
        if (isBrowserTool(part)) {
          // A run of browser calls is one intention; the first one draws the group.
          const previous = parts[i - 1];
          if (previous && previous.type === 'tool' && isBrowserTool(previous)) continue;
          const group = [];
          for (let j = i; j < parts.length && parts[j].type === 'tool' && isBrowserTool(parts[j]); j += 1) group.push(parts[j]);
          body.push(group.length > 1 ? renderBrowserGroup(group, group[0]._k) : renderTool(part));
        } else body.push(renderTool(part));
      }
    }
    // A post the page opened on the turn's first token has no parts yet; its
    // thinking is the live tail underneath, so the placeholder ellipsis would sit
    // above the words it is waiting for (10 Nov). A post opened at the *start* of the
    // turn has neither a tail nor parts for a few seconds while the model reads its
    // prompt: an empty green-headed box read as "nothing is happening", so it says
    // what it is doing (11 Nov).
    // A tool that is running says what it is doing, above whatever text came before it:
    // a page load can take twenty seconds and emits nothing while it does, and the
    // operator could not tell "wait" from "dead" (11 Nov). It is shown even when the
    // model already said something this turn — which is the usual shape of a tool call.
    if (m.live && state.liveTool) {
      body.push(`<div class="trace-line is-waiting">${esc(state.liveTool)}</div>`);
    } else if (parts.length === 0 && !m.error && !(m.live && tail)) {
      body.push(
        waitingHere
          ? `<div class="trace-line is-waiting" data-wait>${esc(waitingText(state.wait, serverNow()) || 'Thinking…')}</div>`
          : '<span class="msg-text">…</span>',
      );
    }
    if (m.error) body.push(`<div class="msg-error">${esc(m.error)}</div>`);
    // A download belongs with the browser's tool cards, above the reasoning — never as
    // an extra after it. It was drawn below the thinking pane, which is the one place
    // nothing goes (the operator's rule); the card itself is already a tool card.
    if (extras) body.splice(1, 0, extras);
    return `<div class="msg assistant${taken}"${line}${takenAttr} data-msg="assistant"><div class="msg-body">${body.join('')}${tail}</div></div>`;
  }
  const body = m.error
    ? `<div class="msg-error">${esc(m.error)}</div>`
    : `<span class="msg-text">${esc(m.text)}</span>`;
  return `<div class="msg${taken}"${line}${takenAttr}><div class="msg-body">${stamp}<span class="msg-role">${esc(m.type)}</span>${body}</div></div>`;
}

let toolSeq = 0;

// The MCP tools arrive named `synapse-browser_open`, which is a machine's word for it.
// The card says what the model is doing instead, so a reader does not have to translate.
const BROWSER_VERBS = {
  open: 'SynaBrowse · Open',
  read: 'SynaBrowse · Read',
  click: 'SynaBrowse · Click',
  type: 'SynaBrowse · Type',
  press: 'SynaBrowse · Key',
  wait: 'SynaBrowse · Wait',
  scroll: 'SynaBrowse · Scroll',
  screenshot: 'SynaBrowse · Screenshot',
  watch: 'SynaBrowse · Watch',
  tabs: 'SynaBrowse · Tabs',
  handoff: 'SynaBrowse · Handoff',
  download: 'SynaBrowse · Download',
  close: 'SynaBrowse · Close',
};

/**
 * Did the turn end with a tool call written into the answer instead of made?
 *
 * The engine sees no tool part, so nothing ran and the turn is over. This is the page's
 * copy of the rule in src/model-slips.js — it only *tells* the operator; no message is
 * sent, because a message after a turn is exactly what must never happen on its own.
 */
export function endsInProseToolCall(messages) {
  const last = (messages || [])[(messages || []).length - 1];
  if (!last || last.type !== 'assistant') return false;
  const parts = last.parts || [];
  if (parts.some((p) => p?.type === 'tool')) return false;
  const texts = parts.filter((p) => p?.type === 'text').map((p) => String(p.text || '').trim()).filter(Boolean);
  const tail = texts[texts.length - 1] || '';
  if (!/<tool_call>/i.test(tail) || !/<\/tool_call>\s*$/i.test(tail)) return false;
  const block = tail.slice(tail.toLowerCase().lastIndexOf('<tool_call>'));
  return /function\s*=|name\s*=|<parameter/i.test(block);
}

/** Is this part one of SynaBrowse's tools? */
export function isBrowserTool(part) {
  return /^synapse-browser[._]/i.test(String(part?.name || ''));
}

/**
 * Consecutive browser calls, folded into one card.
 *
 * A sign-in is open → read → handoff → read: four full cards for one intention, which the
 * operator met as "4 chat entries and I didn't even log in yet" (11 Nov). One card that
 * says how many, with the calls inside it, keeps the turn readable — and a single call
 * still renders as itself.
 */
export function renderBrowserGroup(items, key = '') {
  const id = `browser-group-${toolSeq++}`;
  const open = state.open.has(id);
  // The group's own name for the slide is its first call's, not the drawn id: the id
  // is a counter that starts again at every render, the part's is the call (20 Nov).
  const line = key ? ` data-line="part:${esc(key)}"` : '';
  const failed = items.filter((p) => Boolean(p.failed) || /error|fail/.test(String(p.status || '')));
  const running = items.some((p) => /run|stream|pend|progress/.test(String(p.status || '')));
  const cls = running ? 'warn' : failed.length ? 'err' : 'ok';
  const label = running ? 'working' : failed.length ? `${failed.length} failed` : `${items.length} calls`;
  const rows = items.map((part) => {
    const state = /error|fail/.test(String(part.status || '')) ? 'err' : 'ok';
    const target = toolTarget(part);
    return `<div class="tool-group-row"><span class="status-dot ${state}" role="img" aria-label="${esc(state)}"></span>` +
      `<span class="tool-group-name">${esc(toolLabel(part))}</span>` +
      `<span class="tool-group-target" title="${esc(target)}">${esc(target || '—')}</span></div>`;
  }).join('');
  return `<div class="tool-card tool-group${open ? ' open' : ''}"${line} data-tool-card="${esc(id)}">
    <div class="tool-head" role="button" tabindex="0" data-tool-toggle="${esc(id)}" aria-expanded="${open}" aria-controls="${esc(id)}-detail">
      <span class="status-dot ${cls}" role="img" aria-label="${esc(label)}"></span>
      <span class="tool-name">SynaBrowse</span>
      <span class="tool-target">${items.length} call${items.length === 1 ? '' : 's'}</span>
      <span class="tool-state state-pill ${cls}">${esc(label)}</span>
      <span class="tool-chev" aria-hidden="true">›</span>
    </div>
    <div class="tool-detail" id="${esc(id)}-detail"${open ? '' : ' hidden'}>${rows}</div>
  </div>`;
}

/** A tool's name as the operator reads it. */
export function toolLabel(part) {
  const name = String(part?.name || 'tool');
  const browser = /^synapse-browser[._]([a-z]+)$/i.exec(name);
  if (browser) return BROWSER_VERBS[browser[1].toLowerCase()] || 'SynaBrowse';
  return toolNameLabel(name);
}

/** The live line while a browser tool runs: "SynaBrowse · Opening www.example.test…". */
export function browserLine(input) {
  const i = input && typeof input === 'object' ? input : {};
  const host = (url) => {
    try { return new URL(String(url)).host.replace(/^www\./, ''); } catch { return ''; }
  };
  // A handoff carries its URL too, but the news is that it is waiting for the operator.
  if (i.what) return 'SynaBrowse is asking you to sign in…';
  if (i.timeoutMs !== undefined) return 'SynaBrowse is downloading a file…';
  if (i.url) return `SynaBrowse is opening ${host(i.url) || 'a page'}…`;
  if (i.text && (i.selector === undefined)) return `SynaBrowse is clicking “${String(i.text).slice(0, 40)}”…`;
  if (i.selector) return `SynaBrowse is clicking ${String(i.selector).slice(0, 40)}…`;
  if (i.links !== undefined || i.maxChars !== undefined) return 'SynaBrowse is reading the page…';
  if (i.full !== undefined) return 'SynaBrowse is taking a picture…';
  if (i.ms !== undefined) return 'SynaBrowse is watching the page…';
  if (i.host) return 'SynaBrowse is waiting for you…';
  return '';
}

/** A `question` tool call is answered in the panel above the composer, so its
 *  card is the record rather than the interface: it says what was asked, and the
 *  raw payload is one click away like any other tool. */
export function questionSummary(part) {
  const questions = Array.isArray(part?.input?.questions) ? part.input.questions : [];
  if (!questions.length) return 'you were asked something';
  const first = questions[0] || {};
  const head = String(first.header || first.question || '').replace(/\s+/g, ' ').trim();
  if (!head) return 'you were asked something';
  const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : '';
  return `${head.length > 88 ? `${head.slice(0, 87)}…` : head}${more}`;
}

// The open chat's own lease. A chat turn is not a run, so the server never sends a note
// for it; the call in the conversation is the record, and this reads it once per draw
// rather than scanning every part of every card.
let leaseCache = { sig: '', lease: null };
function sessionLease() {
  const messages = state.messages || [];
  const sig = `${messages.length}:${Number(messages[messages.length - 1]?.created) || 0}`;
  if (leaseCache.sig !== sig) {
    leaseCache = { sig, lease: leaseOfMessages(messages) };
  }
  return leaseCache.lease;
}

// A tool call is one line until you ask for the detail — you rarely need the
// full payload, and a busy turn produces dozens of them.
export function renderTool(part) {  const status = String(part.status || 'unknown').toLowerCase();
  const failed = Boolean(part.failed) || /error|fail/.test(status);
  const running = /run|stream|pend|progress/.test(status);
  // The engine leaves a part as `streaming` when the turn is cut (a Stop, an app
  // restart, a dead session); nothing will ever finish it. Once the chat is no
  // longer busy that part is history, not live, so the card says Stopped instead
  // of a streaming dot that never ends (22 Nov).
  const stale = running && !state.busy;
  const cls = stale ? '' : running ? 'warn' : failed ? 'err' : 'ok';

  // A stable key so an open card survives a re-render; toolSeq is only the
  // fallback for a part with no message identity.
  const id = part._k || `tool-${toolSeq++}`;
  const open = state.open.has(id);
  const target = String(part.name) === 'question' ? questionSummary(part) : toolTarget(part);
  // The file this call names, if it names one: the card's right-click menu opens
  // it, or reveals it in Explorer. A path in the input is the only thing trusted
  // here; the one-line target may be a command or a pattern.
  const file = toolFile(part);
  const input = part.input !== null && part.input !== undefined ? JSON.stringify(part.input, null, 1) : '';
  const output = part.output !== null && part.output !== undefined
    ? (typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 1))
    : '';
  const hasExit = typeof part.exitCode === 'number';
  // One status label, not two. The Error button that used to sit here said the
  // same thing as this pill, and the detail is one click away in the card body.
  const label = stale ? 'Stopped' : failed ? (hasExit ? `Exit ${part.exitCode}` : 'Failed') : status;
  const detail = part.error || output || '(no output)';

  // A chip only when the call reached outside the project: green when the policy
  // allowed it without asking, amber when the operator had to, red when it was
  // refused. A write inside the workspace has nothing to report. The chip itself is
  // one component (`permissionChip`), so a worker's trace wears the same one.
  const decision = part.id ? state.permissionDecisions?.get(part.id) : null;
  const permChip = decision?.outside ? permissionChip(decision) : '';

  return `<div class="tool-card${open ? ' open' : ''}" data-tool-card="${esc(id)}"${file ? ` data-file="${esc(file)}"` : ''}>
    <div class="tool-head" role="button" tabindex="0" data-tool-toggle="${esc(id)}" aria-expanded="${open}" aria-controls="${esc(id)}-detail">
      <span class="status-dot ${cls}" role="img" aria-label="${esc(label)}"></span>
      <span class="tool-name">${esc(toolLabel(part))}</span>
      ${callLeaseClock(part, leaseFor({ dir: currentProject()?.directory }) || sessionLease())}
      <span class="tool-target" title="${esc(target)}">${esc(target)}</span>
      ${permChip}
      <span class="tool-state state-pill ${cls}">${esc(label)}</span>
      <span class="tool-chev" aria-hidden="true">›</span>
    </div>
    <div class="tool-detail" id="${esc(id)}-detail"${open ? '' : ' hidden'}>
      ${input ? `<div class="tool-body"><pre>${esc(input)}</pre></div>` : ''}
      ${output ? `<div class="tool-body"><pre${failed ? ' class="is-error"' : ''}>${esc(output)}</pre></div>` : ''}
      ${part.error ? `<div class="tool-body"><pre class="is-error">${esc(part.error)}</pre></div>` : ''}
    </div>
  </div>`;
}

export function toggleTool(id) {
  const card = document.querySelector(`[data-tool-card="${CSS.escape(id)}"]`);
  if (!card) return;
  const head = card.querySelector('.tool-head');
  const detail = card.querySelector('.tool-detail');
  const open = detail.hidden;
  detail.hidden = !open;
  card.classList.toggle('open', open);
  head.setAttribute('aria-expanded', String(open));
  if (open) state.open.add(id); else state.open.delete(id);
}

export function compactPostHtml(post) {
  const when = post.at
    ? new Date(post.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
  const open = state.open.has('compact-post') ? ' open' : '';
  const count = post.messages ? `${post.messages} messages — ` : '';
  return `<details class="chat-post"${open}><summary><span class="chat-post-mark">Compacted ${esc(
    when,
  )}</span><span class="chat-post-note">${esc(count)}the handover is in the project document</span></summary>` +
    `<div class="chat-post-body" data-fold-body>${renderMarkdown(post.summary)}</div></details>`;
}

/** The tag a chip carries: the file's extension, not a generic word. PNG says
 *  more than IMG about what the operator is about to open. */
/**
 * The bytes of one attached picture, when the message still carries them.
 *
 * The engine keeps them on the raw message (`raw.files[].data`, or a `data:` URI)
 * and a message echoed before the reload keeps them on `_files`. Nothing is
 * copied into the DOM until the operator hovers.
 */
export function attachmentImage(message, index) {
  const files = Array.isArray(message?.raw?.files)
    ? message.raw.files
    : Array.isArray(message?._files)
      ? message._files
      : [];
  const file = files[index];
  if (!file) return null;
  let data = String(file.data || '');
  let mime = String(file.mime || '');
  if (!data && typeof file.uri === 'string' && file.uri.startsWith('data:')) {
    const comma = file.uri.indexOf(',');
    if (comma >= 0) {
      mime = file.uri.slice(5, comma).split(';')[0] || mime;
      data = file.uri.slice(comma + 1);
    }
  }
  // A stored attachment can lose its mime on the way through the engine; the
  // name still says what it is.
  if (!mime) {
    const ext = String(file.name || '').toLowerCase().split('.').pop();
    mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || '';
  }
  if (!data || !/^image\//i.test(mime)) return null;
  return { mime, data };
}

