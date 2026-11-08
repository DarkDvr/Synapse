// The trace: what a worker is doing while it does it, and the one line it folds to
// when the step is over.
//
// A worker's session is its own, so its turns never reach the transcript — the
// operator watched a nine-minute design run with nothing on screen and then one
// report. A trace is the page's own record of that run: the newest tool call, the
// newest sentence, the leases, the compactions and the loops, drawn light grey while
// it is live and folded to a summary afterwards. It is also what makes a worker's
// reasoning stream into the chat at all.
//
// One thing comes from app.js: a redraw of the transcript, because a trace that ends
// has to be re-rendered where it stands. Wired at boot.
import { state } from './state.js';
import { EV } from './events.js';
import { esc, shortSpan, fileChip, reasoningGist } from './format.js';
import { renderMarkdown } from './md.js';
import { fmtTokens, dirKey, roleLabel } from './run-view.js';

const missing = (name) => () => {
  throw new Error(`traces.js: ${name} was not wired at boot`);
};
const wired = {
  renderTranscript: missing('renderTranscript'),
};

/** Hand this module the one thing that lives in app.js. Called once, at boot. */
export function tracesWiring(fns) {
  Object.assign(wired, fns);
}

/**
 * After a compact, the chat is meant to be one post and the new conversation.
 *
 * The fold lines (one per finished run) and the amber alarm lines are page state kept
 * per project, not messages, so they outlived the conversation they described and
 * reappeared above the fresh chat (1 Nov: eleven folds and an alarm under the
 * "Compacted" post). They are that chat's evidence — the run log still has them — so
 * they go with it. The new chat starts with its post and nothing above it.
 */
export function forgetConversation(dir, oldSessionId) {
  const key = dir ? dirKey(dir) : '';
  if (key) {
    for (const [k, t] of [...state.traces]) if (dirKey(t.dir) === key) state.traces.delete(k);
  }
  state.alarms = state.alarms.filter((a) => {
    if (oldSessionId && a.sessionId === oldSessionId) return false;
    if (key && a.dir && dirKey(a.dir) === key) return false;
    return true;
  });
}

/**
 * What a worker is doing, in the chat, while it does it.
 *
 * A worker's session is its own, so its turns never reach this transcript — the
 * operator watched a nine-minute design run with nothing on screen and then one
 * report. Its newest tool call (from the runner) and its newest sentence (read
 * from its session, because that is the only honest source) are shown light grey
 * so the chat is visibly alive, and the whole thing folds to a single line once
 * the run ends: the report is the thing to read, not the transcript behind it.
 */
export function renderTrace(t) {
  const name = roleLabel(t.role);
  const head = [name, t.task, t.title].filter(Boolean);
  // A tool call drawn the way the Architect draws one: a dot, the tool, its target
  // on one line, with the whole command in the tooltip. The switch is
  // `ui.workerCards`; off returns the plain note the trace used to show (8 Nov).
  const cardsOn = () => state.config?.ui?.workerCards !== false;
  const toolLine = (tool, fallback) => {
    const name = String(tool?.name || '').trim();
    const target = String(tool?.target || '').trim() || fallback;
    if (!name) return `<div class="trace-line">${esc(fallback)}</div>`;
    // The Architect's tool card, exactly: the same classes, the same 9px dot in the
    // same flex head, the same type. A worker's call arrives as a name and a target
    // with no detail to open, so the head stands alone — but it is one component in
    // one place, not a lookalike (8 Nov).
    return `<div class="tool-card trace-card"><div class="tool-head"><span class="status-dot ok" role="img" aria-label="tool call"></span><span class="tool-name">${esc(name)}</span><span class="tool-target" title="${esc(target)}">${esc(target)}</span></div></div>`;
  };
  const note = (n) => {
    const text = typeof n === 'string' ? n : String(n?.text || '');
    const steer = typeof n === 'object' && n?.steer === true;
    // A steer is the operator's own instruction: its own line shape, so the tag
    // and the sentence can be centred against each other and the sentence wraps
    // instead of being cut with the steps.
    if (steer) {
      // A steer that carried a file shows it the way the chat shows any attachment:
      // the same chip, the same picture on hover. The bytes are in the project
      // (`.synapse/attachments/`), because a worker's own session is not the chat
      // and its message is the one place the operator cannot see.
      const files = Array.isArray(n?.files) ? n.files : [];
      const chips = files.map((f) => fileChip(f, { src: f.path })).join('');
      return `<div class="trace-line is-steer"><span class="msg-steer">STEER:</span><span class="trace-steer-text">${esc(text)}</span>${chips}</div>`;
    }
    if (n?.prose) {
      // The worker's own words, drawn exactly like an Architect answer: same
      // markdown, same type. Off with the same switch, so the old silent trace is
      // one click away (8 Nov).
      return cardsOn() ? `<div class="trace-prose msg-answer">${renderMarkdown(String(n.text || ''))}</div>` : '';
    }
    if (cardsOn() && n?.tool) return toolLine(n.tool, text);
    return `<div class="trace-line">${esc(text)}</div>`;
  };
  const notes = t.notes || [];
  // Only the last few steps stay open. Everything before is one line that opens:
  // a worker ten minutes in has done forty things, and forty lines of it is the
  // whole chat. This is the shape an editor's agent uses, for the same reason.
  //
  // A steer is not a step, and it is not history either: it is the operator talking
  // to the work that is happening now. It used to sit in the tail, which put it at
  // the *top* of a long trace — above sixty earlier steps and ten folds, off the
  // screen the operator is watching — so it looked as if it had not been sent
  // (8 Nov). It is pinned just above the live panel instead, with the compaction
  // line, and when there is no panel those lines are simply the bottom.
  const isSteer = (n) => typeof n === 'object' && n?.steer === true;
  const steps = notes.filter((n) => !isSteer(n));
  const steers = notes.filter(isSteer);
  const cut = Math.max(0, steps.length - 4);
  const olderSteps = steps.slice(0, cut);
  const tail = steps.slice(cut);
  // What it is saying *now*. The words stream in as they are written, and the last
  // window stays on screen when the step ends — still, and dimmed. Removing it took
  // eleven lines out of the chat and put them back at every step boundary, which a
  // fast model does several times a second. The whole block is rendered and the
  // panel keeps its window; nothing is sliced here, so a re-render never changes a
  // line break.
  const streaming = t.stream && t.stream.text
    ? `<div class="trace-flow${t.stream.kind === 'think' ? ' is-think' : ''}${t.stream.ended ? ' is-idle' : ''}"><div class="trace-flow-view"><div class="trace-flow-body">${esc(
        t.stream.text,
      )}</div></div></div>`
    : '';
  // What the worker finished thinking: the chat's rule exactly — the newest ten as
  // folds of their own, everything older as one "N earlier reasoning" fold. The
  // trace is the only record of a worker's reasoning, so the words are kept behind
  // the line rather than thrown away with the panel. Twelve open lines was the
  // first cut and it read as a wall: the operator counted them (8 Nov).
  const reasons = Array.isArray(t.reasons) ? t.reasons : [];
  const recentReasons = reasons.slice(-10);
  const olderReasons = reasons.slice(0, Math.max(0, reasons.length - 10));
  const reasonFold = (r) =>
    `<details class="reasoning is-trace" data-k="${esc(t.key)}:r${Number(r.at) || 0}">` +
    `<summary>${esc(reasoningGist(r.text))}</summary><pre>${esc(r.text)}</pre></details>`;
  // Steps and thinking are one timeline: a tool call belongs between the thought
  // that asked for it and the thought after it. They used to be two lists — every
  // tool line above every fold — so a long run read as "all the tools, then all the
  // thinking" (8 Nov). Each entry carries its own `at`; an entry without one sorts
  // first, which is where its line already was.
  const when = (x) => Number(x?.at) || 0;
  const entries = [];
  if (olderSteps.length) {
    entries.push({
      at: when(olderSteps[0]),
      html:
        `<details class="trace-archive"><summary>${olderSteps.length} earlier step${olderSteps.length === 1 ? '' : 's'}</summary>` +
        `${olderSteps.map(note).join('')}</details>`,
    });
  }
  if (olderReasons.length) {
    entries.push({
      at: when(olderReasons[0]),
      html:
        `<details class="reasoning is-trace is-archive" data-k="${esc(t.key)}:older">` +
        `<summary>${olderReasons.length} earlier reasoning</summary>` +
        olderReasons.map((r) => `<pre>${esc(r.text)}</pre>`).join('') +
        `</details>`,
    });
  }
  for (const n of tail) entries.push({ at: when(n), html: note(n) });
  for (const r of recentReasons) entries.push({ at: when(r), html: reasonFold(r) });
  entries.sort((a, b) => a.at - b.at || (a.html < b.html ? -1 : a.html > b.html ? 1 : 0));
  const timeline = entries.map((e) => e.html).join('');
  // A compaction line is pinned: the four-line tail is for steps, and this is not
  // a step — it is the reason the next step is slower and the window is empty
  // again. It stays for the whole run, and the folded summary counts it.
  const packed = Number(t.compactions) || 0;
  const compacting = Number(t.compactingSince) || 0;
  // How full the window was when it fired. While it runs, that is the last prompt
  // the run reported (`compactFrom`); afterwards it is the size the engine sent to
  // write the summary, read from the compaction's own usage. The operator wants the
  // pair while it is happening — "Compacting ×3" alone says nothing about why
  // (8 Nov).
  const compactSize = compacting ? Number(t.compactFrom) || 0 : Number(t.compactAt) || 0;
  const compactLimit = Number(t.compactLimit) || 0;
  const compactWhere = compactSize
    ? ` · context at ${fmtTokens(compactSize)}${compactLimit ? `/${fmtTokens(compactLimit)}` : ''}`
    : '';
  // While one is in flight the count is "the ones that have finished, plus this
  // one" — `compactions` only ever counts finished compactions, so the number here
  // is the number of the one being written.
  const compactLine = compacting
    ? `<div class="trace-line is-compact"><span class="trace-mark">⏳</span>Compacting ×${packed + 1}${compactWhere}</div>`
    : packed
      ? `<div class="trace-line is-compact"><span class="trace-mark">⏳</span>Compacted ×${packed}${compactWhere}</div>`
      : '';
  // A loop rescue is pinned for the same reason: it is not a step, and it is the
  // one line that explains why the next thinking is shorter.
  const looped = Number(t.loops) || 0;
  const loopLimit = Number(t.loopLimit) || 3;
  const loopLine = looped
    ? `<div class="trace-line is-loop"><span class="trace-mark">↻</span>Loop detected ×${looped}` +
      (looped >= loopLimit
        ? ` — marked ISSUES, next coder`
        : ` of ${loopLimit} — asking it to carry on`) +
      '</div>'
    : '';
  // Pinned lines: the compaction that emptied the window, the loop rescue that
  // shortened the thinking, and the operator's own steers. All three explain or
  // steer what is happening *now*, so they sit just above the panel — and at the
  // bottom of the trace when no panel is showing.
  const pinned = `${compactLine}${loopLine}${steers.map(note).join('')}`;
  const body = `${timeline}${pinned}${streaming}`;
  const rest = [t.task, t.title].filter(Boolean).join(' · ');
  if (!t.finishedAt) {
    return `<div class="trace is-live" data-trace="${esc(t.key)}">
      <div class="trace-head" title="${esc(head.join(' · '))}"><span class="trace-role">${esc(name)}</span>${rest ? esc(` · ${rest}`) : ''}</div>
      <div class="trace-lines">${body || '<div class="trace-line">starting…</div>'}</div>
    </div>`;
  }
  const took = t.ms ? ` · ${shortSpan(t.ms)}` : '';
  const written = t.files ? ` · ${t.files} file${t.files === 1 ? '' : 's'}` : '';
  // A compaction is not a step of the work, and it is the one thing the operator
  // needs to still see an hour later, so it rides the folded line too.
  const packedNote = Number(t.compactions) ? ` · compacted ×${t.compactions}` : '';
  const loopedNote = looped ? ` · looped ×${looped}` : '';
  // A steer is the operator's own instruction, so a folded trace says it is in
  // there — the text itself is one click away, but it cannot become invisible.
  const steeredNote = notes.some(isSteer) ? ' · steered' : '';
  // The task's own title belongs on the folded line: "Coder 1 · t8" says where,
  // not what. It ellipsizes when the column is short, and the tooltip has the lot.
  const foldHead = [name, t.task, t.title].filter(Boolean).join(' · ');
  return `<details class="trace is-fold" data-trace="${esc(t.key)}">
    <summary title="${esc(foldHead)}"><span class="trace-role">${esc(name)}</span>${rest ? esc(` · ${rest}`) : ''}${took}${written}${packedNote}${loopedNote}${steeredNote}</summary>
    <div class="trace-lines">${body}</div>
  </details>`;
}

/** The traces that belong to a project, in the order they started. */
export function tracesFor(dir) {
  const key = dirKey(dir);
  return [...state.traces.values()].filter((t) => dirKey(t.dir) === key);
}

export const traceKeyOf = (run) => `${dirKey(run.dir)}|${run.task}|${Number(run.startedAt) || 0}`;
// A steer is a note on the run, and it must survive a reload: `/api/runs` carries
// the list, so a page opened mid-run can rebuild the yellow STEER lines — with the
// picture that came with them, which the runner saved in the project.
export const steerNotes = (run) =>
  (Array.isArray(run?.steers) ? run.steers : []).map((s) => ({
    steer: true,
    text: s.text,
    ...(Array.isArray(s.files) && s.files.length ? { files: s.files } : {}),
  }));
export function traceOf(run) {
  return run ? state.traces.get(traceKeyOf(run)) || null : null;
}

/**
 * The trace a runner event belongs to.
 *
 * Its own key when the page saw the run start, and otherwise the newest trace for
 * that task in that project: the same run before a reload has a different
 * `startedAt` (the page rebuilds it from `/api/runs`), and a note that lands in
 * that gap must still reach the right line rather than being dropped in silence.
 */
export function traceFor(ev) {
  const exact = state.traces.get(traceKeyOf(ev));
  if (exact) return exact;
  const dir = dirKey(ev.dir);
  let best = null;
  for (const t of state.traces.values()) {
    if (dirKey(t.dir) !== dir || t.task !== ev.task) continue;
    if (!best || (Number(t.startedAt) || 0) > (Number(best.startedAt) || 0)) best = t;
  }
  return best;
}

/** One compaction, on a trace. `times` is the transcript's own tally, so the
 *  count only ever goes up: a note repeated (a re-sent event, two pages open) must
 *  not become "Compacting ×2" for one compaction. */
export function noteCompaction(trace, { times, used, context } = {}) {
  const counted = Number(times) || 0;
  const known = Number(trace.compactions) || 0;
  trace.compactions = counted > known ? counted : known || 1;
  if (Number(used)) trace.compactAt = Number(used);
  if (Number(context)) trace.compactLimit = Number(context);
}

/** One loop rescue, on a trace. Like a compaction, the count only goes up: a
 *  re-sent event must not turn one rescue into "×2". `to` is the effort it was
 *  lowered to; no `to` means there was nowhere left to go. */
export function noteLoop(trace, { times, limit } = {}) {
  const counted = Number(times) || 0;
  const known = Number(trace.loops) || 0;
  trace.loops = counted > known ? counted : known || 1;
  if (Number(limit)) trace.loopLimit = Number(limit);
  trace.loopStop = trace.loops >= trace.loopLimit;
}

/** The trace of a delegated run whose worker session is this one, if any. */
export function traceForSession(sessionId) {
  if (!sessionId) return null;
  for (const run of state.runs.values()) {
    if (run.workerId === sessionId) return traceOf(run);
  }
  return null;
}

/**
 * The engine compacting a worker's transcript, seen on its own stream.
 *
 * `started` puts the line in the chat while it is happening — the operator watched
 * "compaction.started" sit in the status rail with nothing in the chat beside it,
 * which is the one moment they could have used a word in the conversation. `ended`
 * counts it; `failed` clears the line and counts nothing. The size beside it is the
 * prompt the run last reported, which is the size that caused it.
 */
export function noteCompactionEvent(ev, { used = 0, limit = 0 } = {}) {
  const trace = traceForSession(ev.sessionId);
  if (!trace) return;
  if (ev.type === EV.compactionStarted) {
    trace.compactingSince = Date.now();
    // The size that caused it: the last prompt this run reported, taken from the
    // run on screen. The compaction message's own usage is only readable once the
    // summary is written, and waiting for it means the line says nothing while it
    // runs — which is exactly when the operator wants the number (8 Nov).
    if (Number(used)) trace.compactFrom = Number(used);
    if (Number(limit)) trace.compactLimit = Number(limit);
  } else {
    trace.compactingSince = 0;
    if (ev.type === EV.compactionEnded) {
      // Count it; do not guess its size. The runner reads the compaction's own
      // usage out of the transcript and sends it a moment later, and that is the
      // only number worth printing — `run.ctx` here is *this* poll's prompt, which
      // is the small one if the transcript has already shrunk. Showing that was
      // the "Compacted ×2 · context at 11K" the operator was rightly suspicious of.
      noteCompaction(trace, { times: (Number(trace.compactions) || 0) + 1 });
    }
  }
  wired.renderTranscript();
}

/** What the traces are showing, so a rebuilt transcript is not rebuilt for
 *  nothing while they sit still.
 *
 *  The compaction count is part of it and has to be: a compaction changes no note
 *  and no stream, so without this the `run.note` arrived, set the count, asked for
 *  a re-render — and the re-render found nothing new in this signature and
 *  returned, which is why the operator saw "compaction" in the chip and nothing
 *  in the chat. */
export function traceSig() {
  const own = state.sessionTrace;
  const sessionPart = own?.stream ? `own:${own.key}:${own.stream.text.length}:${own.stream.ended ? 1 : 0}` : '';
  return [
    [...state.traces.values()]
      .map(
        (t) =>
          `${t.key}:${t.finishedAt || 0}:${(t.notes || []).length}:${t.stream ? t.stream.text.length : 0}:` +
          `${t.stream?.ended ? 1 : 0}:${Number(t.compactions) || 0}:${Number(t.compactingSince) || 0}:` +
          `${Number(t.compactFrom) || 0}:${Number(t.compactAt) || 0}:${Number(t.compactLimit) || 0}:` +
          `${(t.reasons || []).length}:${(t.reasons || []).map((r) => String(r.text || '').length).join('.')}:` +
          `${Number(t.loops) || 0}:${Number(t.loopLimit) || 0}:${t.loopStop ? 1 : 0}`,
      )
      .join(';'),
    sessionPart,
  ].join(';');
}

/**
 * The open session's own live step, drawn in the panel the workers get.
 *
 * Once the step's message carries the same words, the message is the record and the
 * panel goes — otherwise the paragraph would be on screen twice.
 */
export function renderSessionStream() {
  const t = state.sessionTrace;
  const text = String(t?.stream?.text || '');
  if (!t?.key || !text.trim()) return '';
  const seen = state.messages
    .flatMap((m) => m.parts || [])
    .filter((p) => p.type === 'reasoning' || p.type === 'text')
    .map((p) => String(p.text || ''))
    .join('\n');
  if (seen.length >= text.length && seen.includes(text.slice(0, 40))) return '';
  // No head line and no rule of its own: this panel sits *inside* the Architect's
  // post, so the post's green line is the only rule and the reasoning keeps its
  // grey. `is-own` is the whole difference from a worker's trace.
  return `<div class="trace is-live is-own" data-trace="${esc(t.key)}">
    <div class="trace-flow${t.stream.kind === 'think' ? ' is-think' : ''}${t.stream.ended ? ' is-idle' : ''}"><div class="trace-flow-view"><div class="trace-flow-body">${esc(text)}</div></div></div>
  </div>`;
}
