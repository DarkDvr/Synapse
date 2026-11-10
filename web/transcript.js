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
import { esc, hhmm, toolTarget, fileChip, shortName, reasoningGist } from './format.js';
import { renderMarkdown } from './md.js';
import { serverNow } from './api.js';
import { permissionNote, permissionChip } from './ask-note.js';
import { alarmsHere, renderAlarm, leasesHere, renderLease, chatErrorsHere, renderChatError } from './chat-notes.js';
import { chatAtBottom, scrollChatToBottom, renderChatNav, captureChatSlack, restoreStreamView } from './chat-scroll.js';
import { currentProject, roleLabel, groupTurns, currentForm } from './run-view.js';
import { renderTrace, tracesFor, traceSig, renderSessionStream } from './traces.js';

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

// ── transcript ──────────────────────────────────────────────────
export function renderTranscript() {
  const el = $('transcript');
  if (!el) return;
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
  const stick = chatAtBottom();
  // The Architect's card shows what its own turn is doing, read from this same
  // transcript, so it is refreshed wherever the transcript is.
  wired.renderRoleActivity();
  // Only the conversation itself is shown: user turns, assistant turns, and the
  // harness speaking (a worker's report being handed back). Anything else the
  // engine reports (system prompts, scaffolding, context dumps) is not chat and
  // once leaked into the transcript above the user's own message. Errors still
  // show, whatever type carries them.
  //
  // Every part carries a stable key (its message id + index) so an expanded
  // Reasoning block or tool card can be restored after a rebuild — a poll
  // landing mid-read used to snap them shut.
  const tagged = state.messages
    .filter((m) => {
      // A compaction the operator stopped is not a failure to read: the chip and
      // the toast already said "cancelled", and the engine's own message would
      // otherwise appear as a red "COMPACTION" block in the chat.
      if (m.type === 'compaction' && /cancell?ed/i.test(String(m.error || ''))) return false;
      return m.error || m.type === 'user' || m.type === 'assistant' || m.type === 'synthetic';
    })
    .map((m) => (m.parts ? { ...m, parts: m.parts.map((p, i) => ({ ...p, _k: `${m.id}:${i}` })) } : m));
  const showable = groupTurns(tagged);
  // Only permissions stay in the transcript: a form is answered in the panel
  // over the chat, and a card here would both duplicate it and change the
  // transcript's height the moment it appeared.
  const pending = wired.renderPermissions();
  // The post a compact left: the only thing the new chat starts with. It is not
  // a message — no speaker — and it comes from this chat's own metadata, so it
  // survives a reload and is gone when the next compact replaces the chat.
  const compactPost = wired.compactPostOf();
  const postHtml = compactPost ? compactPostHtml(compactPost) : '';
  // A question needs room even when the conversation is empty: the panel is the
  // dock's own child and takes its height from the dock, so a freshly opened
  // session (a strip of composer) would show a 64px form with its buttons
  // hanging outside it. A form is something to read, so the dock opens for it.
  const hasHistory =
    showable.length > 0 || Boolean(postHtml) || Boolean(pending) || Boolean(currentForm()) || alarmsHere().length > 0;
  // The dock is a bare composer while empty and fills the stage once there is
  // anything to show; the CSS keys off this class, so set it on every render.
  $('chatDock')?.classList.toggle('has-history', hasHistory);
  // An empty dock sits at the bottom of the page, a full one starts under the
  // cards — so the room left for it has to be re-measured on every change.

  // Nothing in the conversation changed since the last render: leave the DOM —
  // and whatever the operator has open — exactly as it is.
  const sig = hasHistory
    ? `${showable.map((m) => `${m.id}:${m.completed || 0}:${(m.parts || []).length}`).join(',')}|${pending.length}|${state.streaming}|${traceSig()}|${alarmsHere().length}|${state.decisionSeq}|${
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
  const liveTail = renderSessionStream();
  for (let i = 0; i < showable.length; i += 1) {
    const m = showable[i];
    const at = Number(m.created) || 0;
    while (next < items.length && at && items[next].at < at) html += items[next++].html;
    html += renderMessage(m, i === showable.length - 1 && m.type === 'assistant' ? liveTail : '');
  }
  while (next < items.length) html += items[next++].html;
  html += leasesHere().map(renderLease).join('');
  el.innerHTML = html + pending;
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
export function renderMessage(m, tail = '') {
  const t = hhmm(m.created);
  const stamp = t ? `<span class="msg-time">${t}</span>` : '';

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
    // The tag lives inside the text span, not beside it: it is a prefix to the
    // sentence, so the browser aligns it with the first line by itself instead of
    // a flex row's top edge lifting a 9.5px word above a 13.5px one (30 Oct).
    const lead = steer ? '<span class="msg-steer">STEER:</span> ' : '';
    return `<div class="msg user${steer ? ' is-steer' : ''}" data-msg="user"><div class="msg-body">
      ${stamp}<span class="msg-role">You</span><span class="msg-text">${lead}${esc(said)}</span>${chips}${reuse}
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
      return `<div class="msg harness" data-msg="synapse"><div class="msg-body">
        ${stamp}<span class="msg-role">Synapse · ${label}</span>
        <details class="chat-post" data-k="${esc(key)}"${state.open.has(key) ? ' open' : ''}>
          <summary><span class="chat-post-note" title="${esc(full)}">Instructions from ${esc(short)}</span></summary>
          <div class="chat-post-body">${renderMarkdown(rest)}</div>
        </details>
      </div></div>`;
    }
    return `<div class="${cls}" data-msg="synapse"><div class="msg-body">
      ${stamp}<span class="msg-role">Synapse · ${label}</span>
      <div class="msg-answer">${renderMarkdown(body)}</div>
    </div></div>`;
  }
  if (m.type === 'assistant') {
    const body = [`${stamp}<span class="msg-role">Architect</span>`];
    const parts = m.parts || [];
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
    const olderReasoning = reasoningAt.length > REASONING_KEEP ? reasoningAt.slice(0, -REASONING_KEEP) : [];
    const recentReasoning = new Set(reasoningAt.slice(-REASONING_KEEP));
    const archiveKey = `reasoning:${m.id}`;
    for (const [i, part] of parts.entries()) {
      // The model's actual answer goes in its own panel, rendered as markdown,
      // so it is visually separate from reasoning and tool noise. The separator
      // only exists when there was work in this turn to separate it from.
      if (part.type === 'text') {
        const answer = i === lastText && workBefore && !toolAfter ? ' is-answer' : '';
        body.push(`<div class="msg-answer${answer}">${renderMarkdown(part.text)}</div>`);
      }
      else if (part.type === 'reasoning') {
        // The archive takes the place of the oldest block, so the turn still reads
        // in order: the early thinking folded, the recent thinking where it happened.
        if (i === olderReasoning[0]) {
          body.push(
            `<details class="reasoning is-archive" data-k="${esc(archiveKey)}"${state.open.has(archiveKey) ? ' open' : ''}>` +
              `<summary>${olderReasoning.length} earlier reasoning</summary>` +
              olderReasoning.map((n) => `<pre>${esc(parts[n].text)}</pre>`).join('') +
              `</details>`,
          );
        } else if (recentReasoning.has(i)) {
          body.push(
            `<details class="reasoning" data-k="${esc(part._k)}"${state.open.has(part._k) ? ' open' : ''}>` +
              `<summary>${esc(reasoningGist(part.text))}</summary><pre>${esc(part.text)}</pre></details>`,
          );
        }
      }
      else if (part.type === 'tool') body.push(renderTool(part));
    }
    // A post the page opened on the turn's first token has no parts yet; its
    // thinking is the live tail underneath, so the placeholder ellipsis would sit
    // above the words it is waiting for (10 Nov).
    if (parts.length === 0 && !m.error && !(m.live && tail)) body.push('<span class="msg-text">…</span>');
    if (m.error) body.push(`<div class="msg-error">${esc(m.error)}</div>`);
    return `<div class="msg assistant" data-msg="assistant"><div class="msg-body">${body.join('')}${tail}</div></div>`;
  }
  const body = m.error
    ? `<div class="msg-error">${esc(m.error)}</div>`
    : `<span class="msg-text">${esc(m.text)}</span>`;
  return `<div class="msg"><div class="msg-body">${stamp}<span class="msg-role">${esc(m.type)}</span>${body}</div></div>`;
}

let toolSeq = 0;

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

// A tool call is one line until you ask for the detail — you rarely need the
// full payload, and a busy turn produces dozens of them.
export function renderTool(part) {
  const status = String(part.status || 'unknown').toLowerCase();
  const failed = Boolean(part.failed) || /error|fail/.test(status);
  const running = /run|stream|pend|progress/.test(status);
  const cls = running ? 'warn' : failed ? 'err' : 'ok';

  // A stable key so an open card survives a re-render; toolSeq is only the
  // fallback for a part with no message identity.
  const id = part._k || `tool-${toolSeq++}`;
  const open = state.open.has(id);
  const target = String(part.name) === 'question' ? questionSummary(part) : toolTarget(part);
  const input = part.input !== null && part.input !== undefined ? JSON.stringify(part.input, null, 1) : '';
  const output = part.output !== null && part.output !== undefined
    ? (typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 1))
    : '';
  const hasExit = typeof part.exitCode === 'number';
  // One status label, not two. The Error button that used to sit here said the
  // same thing as this pill, and the detail is one click away in the card body.
  const label = failed ? (hasExit ? `Exit ${part.exitCode}` : 'Failed') : status;
  const detail = part.error || output || '(no output)';

  // A chip only when the call reached outside the project: green when the policy
  // allowed it without asking, amber when the operator had to, red when it was
  // refused. A write inside the workspace has nothing to report. The chip itself is
  // one component (`permissionChip`), so a worker's trace wears the same one.
  const decision = part.id ? state.permissionDecisions?.get(part.id) : null;
  const permChip = decision?.outside ? permissionChip(decision) : '';

  return `<div class="tool-card${open ? ' open' : ''}" data-tool-card="${esc(id)}">
    <div class="tool-head" role="button" tabindex="0" data-tool-toggle="${esc(id)}" aria-expanded="${open}" aria-controls="${esc(id)}-detail">
      <span class="status-dot ${cls}" role="img" aria-label="${esc(label)}"></span>
      <span class="tool-name">${esc(part.name)}</span>
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
    `<div class="chat-post-body">${renderMarkdown(post.summary)}</div></details>`;
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

