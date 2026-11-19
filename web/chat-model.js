// The item model: one ordered list a renderer can walk.
//
// The renderer is the easy half of the chat. The rules are the hard half — which messages
// are one post, where an alarm splits a turn, which post the live pane belongs to, which
// post a download happened in, what a line's position is, and what the key of every fold
// is. All of that lives here, once, as a pure function of the page's state. The renderer
// then draws the list and knows none of it.
//
// Two properties are the point:
//
//   * **It is pure.** No DOM, no HTML, no timers, no mutation. Given the same state it
//     returns the same list, so a scenario can assert the model and the pixels separately.
//   * **The keys never move.** A key is derived from what the thing *is* (`<messageId>:<i>`,
//     `reasoning:<id>`, `<traceKey>:older`, `download:<id>`), never from its position — a
//     neighbour appearing must not rename anything, or the fold the operator opened closes
//     itself. See docs/notes/chat-inventory.md, section 7, which this implements.
//
// The old renderer (web/transcript.js) still does its own version of all this. Both are on
// screen during the rebuild; the scenarios in tests/scenarios/ run against each, and a
// disagreement is a bug in one of them.
import { state as pageState } from './state.js';
import { downloadAt } from './downloads.js';
import { toolTarget } from './format.js';

/** What "the end" means for something that has no time of its own. */
const END = Number.MAX_SAFE_INTEGER;
const DOWNLOAD_MAX_AGE_MS = 10 * 60 * 1000;

const dirKey = (d) => String(d ?? '').replace(/[\\/]+$/, '').toLowerCase();
const when = (x) => Number(x?.at) || 0;
const isOpen = (src, key) => Boolean(src.open && src.open.has && src.open.has(key));
const showCards = (src) => src.config?.ui?.workerCards !== false;
const isSteer = (n) => typeof n === 'object' && n && n.steer === true;
const isBrowser = (part) => /^synapse-browser[._]/i.test(String(part?.name || ''));

function projectOf(src) {
  const id = src.sessionId;
  if (!id) return null;
  return (src.projects || []).find((p) => (p.sessions || []).some((s) => s.id === id)) || null;
}

/** The alarms that belong to this conversation: this session's, or this project's. */
function alarmsHere(src, dir) {
  return (src.alarms || []).filter(
    (a) => !a.sessionId || a.sessionId === src.sessionId || (a.dir && dir && dirKey(a.dir) === dirKey(dir)),
  );
}

function leasesHere(src, dir) {
  return [...(src.leases instanceof Map ? src.leases.values() : [])].filter(
    (lease) => !lease.dir || !dir || dirKey(lease.dir) === dirKey(dir),
  );
}

/** The project's downloads: recent ones only, oldest first, newest four. */
function downloadsFor(src, dir) {
  const key = dirKey(dir);
  if (!key || !(src.downloads instanceof Map)) return [];
  const now = Date.now();
  return [...src.downloads.values()]
    .filter((d) => dirKey(d.dir) === key)
    .filter((d) => !d.endedAt || now - Number(d.endedAt) < DOWNLOAD_MAX_AGE_MS)
    .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0))
    .slice(-4);
}

function tracesFor(src, dir) {
  const key = dirKey(dir);
  return [...(src.traces instanceof Map ? src.traces.values() : [])].filter((t) => dirKey(t.dir) === key);
}

// ── the message list ─────────────────────────────────────────────

/**
 * Messages as posts: a compaction the operator stopped is not failure news; a refusal line
 * already drawn as an alarm is not drawn again from the harness message that repeats it;
 * everything the engine adds for its own reasons (system prompts, context dumps) is
 * scaffolding, not chat.
 */
function conversation(src, refusals) {
  return (src.messages || [])
    .filter((m) => {
      if (m.type === 'compaction' && /cancell?ed/i.test(String(m.error || ''))) return false;
      if (m.type === 'compaction') return Boolean(m.raw?.status);
      if (String(m.description || '').trim().toUpperCase() === 'PROHIBITED') {
        const at = Number(m.created) || 0;
        if (refusals.some((covered) => Math.abs(covered - at) <= 15_000)) return false;
      }
      return m.error || m.type === 'user' || m.type === 'assistant' || m.type === 'synthetic';
    })
    .map((m) => ({
      ...m,
      // The key of a part is fixed the moment it arrives: message id plus its own index.
      parts: (m.parts || []).map((p, i) => ({ ...p, key: `${m.id}:${i}` })),
    }));
}

/**
 * Where a merged turn must stop: the step that follows a prohibition.
 *
 * The engine sends one message per step and a turn is one post. An alarm that arrived
 * between two steps belongs to the moment it happened, so the merge stops at the first
 * assistant step at or after it (15 Nov).
 */
function alarmBreaks(messages, alarmTimes) {
  const breaks = new Set();
  for (const at of alarmTimes || []) {
    if (!at) continue;
    const hit = (messages || []).find((m) => m?.type === 'assistant' && (Number(m.created) || 0) >= at);
    if (hit?.id) breaks.add(hit.id);
  }
  return breaks;
}

/** Consecutive assistant messages are one post: one header, the steps in order. */
function groupTurns(messages, breakBefore) {
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.type === 'assistant' && prev?.type === 'assistant' && !breakBefore.has(m.id)) {
      prev.parts = [...prev.parts, ...m.parts];
      prev.text = `${prev.text || ''}${m.text || ''}`;
      prev.error = prev.error || m.error;
      prev.completed = m.completed || prev.completed;
      continue;
    }
    out.push({ ...m, parts: [...(m.parts || [])] });
  }
  return out;
}

// ── blocks ───────────────────────────────────────────────────────

/**
 * A fold's summary: its first sentence, whole.
 *
 * The same rule the old chat's `reasoningGist` uses (web/format.js): flattened onto one line
 * and cut at the first full stop. Whole, not clipped at a character count — a fold that ends
 * mid-word in the summary is a fold the operator has to open to understand, and it made the
 * two chats draw different words for the same reasoning block (19 Nov, measured at 172
 * characters on one fold).
 */
function firstLine(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const end = flat.search(/[.!?](?:\s|$)/);
  return end > 0 ? flat.slice(0, end + 1) : flat;
}

/** A tool part as card data: the raw facts, never the sentence — the renderer words it. */
function toolish(part) {
  return {
    name: String(part.name || 'tool'),
    status: String(part.status || 'unknown').toLowerCase(),
    input: part.input ?? null,
    output: part.output ?? null,
    error: part.error || null,
    exitCode: typeof part.exitCode === 'number' ? part.exitCode : null,
    failed: Boolean(part.failed),
    // The one-line target, from the one function that words it (web/format.js): the card
    // clips it with CSS, so the full command stays in the element for a hover or a copy.
    target: toolTarget(part),
  };
}

function toolCard(src, part, key) {
  const decision = part.id ? src.permissionDecisions?.get?.(part.id) : null;
  return {
    kind: 'card',
    key: key || part.key,
    card: part.name === 'question' ? 'question' : 'tool',
    props: {
      ...toolish(part),
      // A chip only when the call reached outside the project and there was a decision.
      permission: decision && decision.outside ? decision : null,
    },
    open: isOpen(src, key || part.key),
  };
}

/** The blocks of one Architect turn, in the order the engine wrote them. */
function assistantBlocks(src, m) {
  const blocks = [];
  const parts = m.parts || [];
  const texts = parts.map((p, i) => (p.type === 'text' ? i : -1)).filter((i) => i >= 0);
  const lastText = texts[texts.length - 1];
  const workBefore = lastText !== undefined && parts.slice(0, lastText).some((p) => p.type === 'reasoning' || p.type === 'tool');
  const toolAfter = lastText !== undefined && parts.slice(lastText + 1).some((p) => p.type === 'tool');

  const reasoning = parts
    .map((p, i) => (p.type === 'reasoning' && String(p.text || '').trim() ? i : -1))
    .filter((i) => i >= 0);
  // The newest ten keep their own folds; everything older is one archive at the place the
  // oldest of them was, so the turn still reads in order (8 Nov).
  const older = reasoning.length > 10 ? reasoning.slice(0, -10) : [];
  const recent = new Set(reasoning.slice(-10));
  const archiveKey = `reasoning:${m.id}`;

  for (const [i, part] of parts.entries()) {
    if (part.type === 'text') {
      blocks.push({
        kind: 'prose',
        // By where it sits, not by the message's id: the page's live placeholder and the
        // engine's message are the same post, and a block keyed by the id would be rebuilt
        // when the id changed under it — taking the operator's selection with it (19 Nov).
        // A paragraph carries no open/closed state, so nothing needs the key to be global.
        key: `p${i}`,
        text: String(part.text || ''),
        // The last text of a turn that did work is the answer; narration in a step that
        // then calls a tool is not.
        answer: i === lastText && workBefore && !toolAfter,
      });
      continue;
    }
    if (part.type === 'reasoning') {
      if (i === older[0]) {
        blocks.push({
          kind: 'fold',
          key: archiveKey,
          tone: 'archive',
          summary: `${older.length} earlier reasoning`,
          format: 'pre',
          body: older.map((n) => String(parts[n].text || '')).join('\n\n'),
          open: isOpen(src, archiveKey),
        });
      } else if (recent.has(i)) {
        blocks.push({
          kind: 'fold',
          key: part.key,
          tone: 'reasoning',
          summary: firstLine(part.text),
          format: 'pre',
          body: String(part.text || ''),
          open: isOpen(src, part.key),
        });
      }
      continue;
    }
    if (part.type === 'tool') {
      if (isBrowser(part)) {
        // A run of browser calls is one intention: one card, the calls inside it (11 Nov).
        const previous = parts[i - 1];
        if (previous && previous.type === 'tool' && isBrowser(previous)) continue;
        const calls = [];
        for (let j = i; j < parts.length && parts[j].type === 'tool' && isBrowser(parts[j]); j += 1) calls.push(toolish(parts[j]));
        blocks.push({ kind: 'card', key: part.key, card: 'browser', props: { calls }, open: isOpen(src, part.key) });
        continue;
      }
      blocks.push(toolCard(src, part));
    }
  }
  return { blocks, lastText };
}

// ── traces ───────────────────────────────────────────────────────

/** A delegated run as a post variant: the same spine, a timeline of lines, cards and folds. */
function traceItem(src, t, at) {
  const notes = t.notes || [];
  const steers = notes.filter(isSteer);
  const steps = notes.filter((n) => !isSteer(n));
  const reasons = Array.isArray(t.reasons) ? t.reasons : [];
  // Only the last four steps and the last ten thoughts stay open; everything older is one
  // archive, in time order, so a ten-minute run does not become the whole chat (8–10 Nov).
  const cut = Math.max(0, steps.length - 4);
  const olderSteps = steps.slice(0, cut);
  const tailSteps = steps.slice(cut);
  const olderReasons = reasons.slice(0, Math.max(0, reasons.length - 10));
  const recentReasons = reasons.slice(-10);

  const noteBlock = (n) => {
    const text = typeof n === 'string' ? n : String(n?.text || '');
    if (isSteer(n)) {
      return {
        kind: 'line',
        key: `${t.key}:s${when(n)}`,
        line: 'steer',
        at: when(n),
        props: { text, files: Array.isArray(n.files) ? n.files : [], pending: Boolean(n.pending) },
      };
    }
    if (n && n.prose) return { kind: 'prose', key: `${t.key}:p${when(n)}`, text, answer: true };
    if (showCards(src) && n && n.tool) {
      return { kind: 'card', key: `${t.key}:t${when(n)}`, card: 'tool', props: { name: String(n.tool.name || 'tool'), target: String(n.tool.target || ''), only: true }, open: false };
    }
    if (n && n.perm) {
      return { kind: 'card', key: `${t.key}:m${when(n)}`, card: 'permission', props: { decision: n.perm, record: true }, open: false };
    }
    return { kind: 'line', key: `${t.key}:n${when(n)}`, line: 'note', at: when(n), props: { text } };
  };

  const reasonFold = (r) => ({
    kind: 'fold',
    key: `${t.key}:r${when(r)}`,
    tone: 'reasoning',
    summary: firstLine(r.text),
    format: 'pre',
    body: String(r.text || ''),
    open: isOpen(src, `${t.key}:r${when(r)}`),
  });

  const entries = [
    ...olderSteps.map((n) => ({ at: when(n), older: true, block: noteBlock(n) })),
    // Inside the archive an older thought is its text, not a fold: the archive is the fold.
    ...olderReasons.map((r) => ({ at: when(r), older: true, block: { kind: 'prose', key: `${t.key}:o${when(r)}`, text: String(r.text || ''), answer: false, format: 'pre' } })),
    ...tailSteps.map((n) => ({ at: when(n), older: false, block: noteBlock(n) })),
    ...recentReasons.map((r) => ({ at: when(r), older: false, block: reasonFold(r) })),
    ...steers.map((n) => ({ at: when(n), older: false, block: noteBlock(n) })),
    ...(t.marks || [])
      .filter((m) => m && (m.kind === 'compact' || m.kind === 'loop'))
      .map((m) => ({
        at: when(m),
        older: false,
        block:
          m.kind === 'loop'
            ? { kind: 'line', key: `${t.key}:l${when(m)}`, line: 'loop', at: when(m), props: { count: Number(m.count) || 0, limit: Number(t.loopLimit) || 3 } }
            : {
                kind: 'line',
                key: `${t.key}:c${when(m)}`,
                line: 'compact',
                at: when(m),
                props: { running: false, count: Number(m.count) || 0, size: Number(m.size) || 0, limit: Number(m.limit) || 0 },
              },
      })),
  ].sort((a, b) => a.at - b.at || (a.block.key < b.block.key ? -1 : a.block.key > b.block.key ? 1 : 0));

  const archiveBody = entries.filter((e) => e.older).map((e) => e.block);
  const blocks = [];
  let archivePlaced = false;
  for (const entry of entries) {
    if (entry.older) {
      if (!archivePlaced && archiveBody.length) {
        blocks.push({
          kind: 'fold',
          key: `${t.key}:older`,
          tone: 'archive',
          summary: `Older entries (${archiveBody.length})`,
          format: 'blocks',
          body: archiveBody,
          open: isOpen(src, `${t.key}:older`),
        });
        archivePlaced = true;
      }
      continue;
    }
    blocks.push(entry.block);
  }

  const folded = Boolean(t.finishedAt);
  if (!folded && t.stream && t.stream.text) {
    blocks.push({
      kind: 'stream',
      key: `${t.key}:stream`,
      text: String(t.stream.text || ''),
      live: !t.stream.ended,
      collapsed: Boolean(t.thinkCollapsed),
    });
  }
  return {
    kind: 'trace',
    key: t.key,
    role: t.role || '',
    task: t.task || '',
    title: t.title || '',
    at,
    state: folded ? 'folded' : 'live',
    open: isOpen(src, `${t.key}:fold`),
    folded,
    ms: Number(t.ms) || 0,
    files: Number(t.files) || 0,
    compactions: Number(t.compactions) || 0,
    loops: Number(t.loops) || 0,
    steered: steers.length > 0,
    blocks,
  };
}

// ── lines ────────────────────────────────────────────────────────

function alarmItems(src, alarms) {
  return alarms.map((a) => {
    const at = Number(a.at) || 0;
    const key = `alarm:${at}:${a.action || ''}`;
    if (a.prohibited) {
      return {
        kind: 'line',
        key,
        line: 'refusal',
        at,
        props: {
          action: String(a.action || 'tool'),
          paths: (a.paths || []).map(String),
          note: String(a.note || ''),
          open: isOpen(src, key),
        },
      };
    }
    return { kind: 'line', key, line: 'alarm', at, props: { what: String(a.what || ''), paths: (a.paths || []).map(String), note: String(a.note || '') } };
  });
}

/** A compaction message, in the conversation: one line, where it happened. */
function compactionItem(src, m) {
  const running = String(m.raw?.status || '') === 'running';
  const index = (src.messages || []).filter((x) => x.type === 'compaction' && Number(x.created) <= Number(m.created)).length;
  const tokens = m.raw?.tokens || {};
  const limit = Number(src.archLimit) || 0;
  const size = Math.max(0, (Number(tokens.input) || 0) + (Number(tokens.cache?.read) || 0));
  return {
    kind: 'line',
    key: `compaction:${m.id || Number(m.created) || 0}`,
    line: 'compact',
    at: Number(m.created) || 0,
    props: { running, count: Math.max(1, index), size, limit },
  };
}

// ── the model ────────────────────────────────────────────────────

/**
 * Build the ordered list the renderer draws.
 *
 * @param {object} [src] the page's state (the singleton by default)
 * @returns {{ handover: object|null, items: object[], pending: object[] }}
 */
export function buildChat(src = pageState) {
  const project = projectOf(src);
  const dir = project?.directory || '';
  const alarms = alarmsHere(src, dir);
  const refusals = alarms.filter((a) => a.prohibited).map((a) => Number(a.at) || 0);
  const messages = conversation(src, refusals);
  const showable = groupTurns(messages, alarmBreaks(messages, refusals));
  const downloads = downloadsFor(src, dir);
  const placed = new Set();

  // The newest assistant post owns the live pane, even when a line arrived after it.
  let paneAt = -1;
  showable.forEach((m, i) => {
    if (m?.type === 'assistant') paneAt = i;
  });
  const last = showable.at(-1);
  const live = Boolean(src.busy) || Boolean(last?.type === 'assistant' && !last?.completed && !last?.error);
  // The pane belongs to the newest assistant post, even when a line arrived after it — and it
  // is still there after the turn ends, dim, until the app clears it for the next turn. The
  // page decides when the step's words stop being the news; the model draws what it is given.
  const pane = src.sessionTrace?.stream?.text
    ? {
        text: String(src.sessionTrace.stream.text),
        ended: Boolean(src.sessionTrace.stream.ended),
        // Folding the pane to its one-line "Thinking…" is the operator's own switch: the
        // app keeps it on the session's trace, the same place a worker's trace keeps its
        // own (web/thinking-pane.js).
        collapsed: Boolean(src.sessionTrace.thinkCollapsed),
      }
    : null;

  // Everything that sits between posts, by its own time.
  const between = [
    ...alarmItems(src, alarms),
    ...(src.errors || []).map((e) => ({
      kind: 'line',
      key: `error:${Number(e.at) || 0}`,
      line: 'error',
      at: Number(e.at) || 0,
      props: { title: String(e.title || ''), detail: String(e.detail || '') },
    })),
    ...tracesFor(src, dir).map((t) => traceItem(src, t, t.finishedAt ? Number(t.startedAt) || 0 : END)),
  ].sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const items = [];
  let next = 0;
  for (const [i, m] of showable.entries()) {
    const at = Number(m.created) || 0;
    while (next < between.length && at && between[next].at < at) items.push(between[next++]);
    if (m.type === 'compaction') {
      items.push(compactionItem(src, m));
      continue;
    }
    const until = Number(showable[i + 1]?.created) || Number.POSITIVE_INFINITY;
    const mine =
      m.type === 'assistant'
        ? downloads.filter((d) => downloadAt(d) >= at && downloadAt(d) < until && !placed.has(d.id))
        : [];
    for (const d of mine) placed.add(d.id);
    items.push(postFor(src, m, { mine, pane: i === paneAt ? pane : null, ordinal: i }));
  }
  while (next < between.length) items.push(between[next++]);

  // A card that fits no post still has to be somewhere: a chat with no assistant message.
  for (const d of downloads.filter((x) => !placed.has(x.id))) {
    items.push({ kind: 'line', key: `orphan:${d.id}`, line: 'none', at: END, props: { download: d } });
  }

  // A lease is a clock over the work, not a message: after the conversation.
  for (const lease of leasesHere(src, dir)) {
    items.push({ kind: 'line', key: `lease:${lease.dir}|${lease.task}`, line: 'lease', at: END, props: { ...lease } });
  }

  // Permission cards are the operator's own queue: after the conversation, never inside it.
  const pending = (src.permissions || [])
    .filter((p) => p.requestId)
    .map((p) => ({ kind: 'card', key: `perm:${p.requestId}`, card: 'permission', props: { ...p }, open: false }));

  const compacted = src.handover || compactedOf(src);
  const handover = compacted
    ? {
        kind: 'fold',
        key: 'compact-post',
        tone: 'handover',
        summary: handoverSummary(compacted),
        format: 'markdown',
        body: String(compacted.summary || ''),
        open: isOpen(src, 'compact-post'),
        at: Number(compacted.at) || 0,
      }
    : null;

  // The question panel is not part of the column: it is the last thing on screen, and it
  // owns its answers. The model says what to draw; the view keeps the DOM (and the input)
  // across updates.
  return { handover, items, pending, form: formItem(src) };
}

/** The form waiting on the operator: the open chat's own, or a worker's. */
function formItem(src) {
  const forms = (src.forms || []).filter((f) => f && f.id);
  const form = forms.find((f) => f.sessionId === src.sessionId) || forms[0];
  if (!form) return null;
  const runs = src.runs instanceof Map ? [...src.runs.values()] : [];
  return {
    kind: 'form',
    key: `form:${form.id}`,
    id: String(form.id),
    sessionId: String(form.sessionId || ''),
    title: String(form.title || 'Input Needed'),
    fields: (form.fields || []).map((field, index) => ({
      key: String(field.key ?? `q${index}`),
      title: String(field.title || ''),
      description: String(field.description || ''),
      type: String(field.type || 'string'),
      options: Array.isArray(field.options) ? field.options.map((o) => ({ value: String(o.value), label: String(o.label ?? o.value), description: String(o.description || '') })) : [],
      custom: Boolean(field.custom),
      required: Boolean(field.required),
      when: Array.isArray(field.when) ? field.when : null,
      minimum: field.minimum ?? null,
      maximum: field.maximum ?? null,
      default: field.default ?? null,
      placeholder: String(field.placeholder || ''),
      url: String(field.url || ''),
      hidden: Boolean(field.hidden),
    })),
    // A worker's question has no chat to open: it is answered here, over the Architect's.
    here: form.sessionId === src.sessionId,
    worker: runs.some((r) => r && r.workerId === form.sessionId),
    autoAnswer: (form.autoAnswer ?? src.automation?.autoAnswer) === true,
    firstAt: Number(form.autoAnswerFirstAt) || null,
    wait: Number(src.answerWaitSec) || 0,
    pages: Math.max(1, Number(form.autoAnswerPages) || 1),
  };
}

function postFor(src, m, { mine, pane, ordinal = 0 }) {
  const speaker = m.type === 'user' ? 'you' : m.type === 'synthetic' ? 'synapse' : 'architect';
  const at = Number(m.created) || 0;
  const blocks = [];
  if (m.type === 'user') {
    // A steer keeps the engine's marker in its text; the chat shows the tag, not the marker.
    const steer = /^\[steer\]\s*([\s\S]*)$/.exec(String(m.text || ''));
    // Plain, not markdown: these are the operator's own words, and the old chat has always
    // shown them as typed. A list of "1. …" turned into a numbered list is not the message
    // they sent (19 Nov, seen on a real conversation the moment the switch went on).
    blocks.push({ kind: 'prose', key: 'text', text: steer ? steer[1] : String(m.text || ''), format: 'plain', answer: false });
  } else if (m.type === 'synthetic') {
    const body = String(m.text || '').replace(/^\s*\[harness\]\s*/i, '');
    const label = String(m.description || '');
    if (/^loaded\s/i.test(label) && /^instructions from:/i.test(body)) {
      const nl = body.indexOf('\n');
      const head = nl === -1 ? body : body.slice(0, nl);
      const rest = nl === -1 ? '' : body.slice(nl + 1).replace(/^\s+/, '');
      const full = String(/^instructions from:\s*(.*)$/i.exec(head)?.[1] || '').trim();
      const short = full.split(/[\\/]/).filter(Boolean).slice(-2).join('\\') || full;
      const key = `loaded:${m.id}`;
      blocks.push({ kind: 'fold', key, tone: 'loaded', summary: `Instructions from ${short}`, format: 'markdown', body: rest, open: isOpen(src, key), title: full });
    } else if (String(m.description || '').trim().toUpperCase() === 'PROHIBITED') {
      const key = `refused:${m.id}`;
      const sentence = String(body || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
      blocks.push({
        kind: 'fold',
        key,
        tone: 'refusal',
        summary: '⛔ PROHIBITED · the protected list refused this change',
        format: 'pre',
        body: String(body || ''),
        open: isOpen(src, key),
        title: sentence,
      });
    } else {
      blocks.push({ kind: 'prose', key: 'text', text: body, answer: false });
    }
  } else {
    blocks.push(...assistantBlocks(src, m).blocks);
  }

  // What a tool is doing, in words, while it runs and the turn emits nothing (11 Nov).
  if (m.live && src.liveTool) blocks.push({ kind: 'line', key: 'waiting', line: 'waiting', props: { text: String(src.liveTool) } });
  if (pane) blocks.push({ kind: 'stream', key: 'pane', text: pane.text, live: !pane.ended, collapsed: pane.collapsed });
  for (const d of mine) blocks.push({ kind: 'card', key: `download:${d.id}`, card: 'download', props: { ...d }, open: false });

  return {
    kind: 'post',
    // A post is keyed by where it sits, not by the engine's message id.
    //
    // The id is the one thing about a live turn that changes under the operator: the page
    // opens a `local-live-…` placeholder before the engine has a message, and the engine's
    // real message replaces it at the same place. Keyed by id, that swap replaced the whole
    // post — and with it the text the operator had selected, and the pane that was being
    // written into (19 Nov: "selection is once again cleared when chat updates").
    key: `post:${ordinal}`,
    speaker,
    at,
    state: m.error ? 'error' : m.type === 'assistant' && !m.completed && !m.error ? 'live' : 'done',
    error: m.error ? String(m.error) : null,
    // What the message carries besides its words: the operator's own post shows what was
    // attached, and can be copied back into the composer.
    files: Array.isArray(m.files) ? m.files.map((f) => ({ name: String(f?.name || ''), mime: String(f?.mime || '') })) : [],
    // A worker's report says which run it came from: "Synapse · worker t1 (coder-1) completed"
    // is the header the old chat draws, and without it a report has no author.
    title: m.type === 'synthetic' ? String(m.description || '') : '',
    steer: /^\[steer\]\s*/.test(String(m.text || '')),
    reuseId: m.type === 'user' && m.id ? m.id : null,
    blocks,
  };
}

function handoverSummary(h) {
  const when = h.at
    ? new Date(Number(h.at)).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';
  const count = h.messages ? `${h.messages} messages — ` : '';
  // The same sentence the old chat's compact post carries, dash for dash: this is the one
  // line that tells the operator the conversation above it was folded away.
  return `Compacted ${when} — ${count}the handover is in the project document`;
}

/**
 * The compact post, as the session records it.
 *
 * The old chat reads the same record (`web/compact.js`, `compactPostOf`): the session's own
 * metadata says when the conversation was folded and how many messages went with it. The
 * model reads it here rather than being handed it, so a switched page draws the compact post
 * without any of the app's glue being taught about the new renderer.
 */
function compactedOf(src) {
  const sessions = (src.projects || []).flatMap((p) => (p && p.sessions) || []);
  const meta = sessions.find((s) => s && s.id === src.sessionId)?.metadata?.synapse?.compacted;
  if (!meta || !meta.summary) return null;
  return { at: Number(meta.at) || 0, summary: String(meta.summary), messages: Number(meta.messages) || 0 };
}
