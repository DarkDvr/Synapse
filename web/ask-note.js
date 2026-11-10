// The line beside a question's title, and the clock Auto-Answer counts on.
//
// It read "another chat is waiting on you · full auto answers on its next check" —
// two clauses answering different questions, the first one false when the run
// answers for itself. It is now one short sentence that counts down: "Auto-Answering
// in 7 seconds…". The operator asked for that wording on 3 Nov, after a longer one
// ("answering with recommended options…") filled the head and still explained less.
//
// Kept apart from app.js so both are testable without a page: no DOM, no state.
// tests/ask-note.test.mjs calls them directly.
import { esc } from './format.js';
import { roleLabel } from './run-view.js';

/**
 * Where the form is in its countdown.
 *
 * Auto-Answer works one *page* at a time: the wait belongs to the question on
 * screen, and when it runs out the panel moves to the next one, which gets its own
 * wait. A three-question form therefore takes three waits, and the reply goes to
 * the engine after the last one.
 *
 * @param {{ firstAt: number, wait?: number, pages?: number, now?: number }} input
 *   `firstAt` is when the first page appeared (epoch ms), `wait` is one page's wait
 *   in seconds, `pages` how many questions the form holds.
 * @returns {{ page: number, seconds: number }} the page the clock says is due, and
 *   the seconds left on it (never negative).
 */
export function answerTimeline({ firstAt, wait = 0, pages = 1, now = Date.now() } = {}) {
  const waitMs = Math.max(1, Math.floor(Number(wait) || 0)) * 1000;
  const count = Math.max(1, Math.floor(Number(pages) || 1));
  const started = Number(firstAt);
  const at = Number(now);
  const elapsed = Number.isFinite(started) ? at - started : 0;
  const page = Math.min(count - 1, Math.max(0, Math.floor(elapsed / waitMs)));
  const end = (Number.isFinite(started) ? started : at) + (page + 1) * waitMs;
  return { page, seconds: Math.max(0, Math.ceil((end - at) / 1000)) };
}

/**
 * @param {{ here?: boolean, autoAnswer?: boolean, seconds?: number }} [input]
 *   `here` is true when the question belongs to the chat on screen; `seconds` is
 *   the number left on this page (see answerTimeline).
 * @returns {string} the note, ready to render (no markup, no escaping needed).
 */
export function askHeadNote({ here = true, autoAnswer = false, worker = false, seconds = 0 } = {}) {
  // A worker has no chat in the rail to open: its question is posted here, over the
  // Architect's conversation, and answered here. Saying "another chat" sent the
  // operator looking for one that does not exist (8 Nov).
  const from = worker ? 'a worker is waiting — ' : 'another chat — ';
  if (!autoAnswer) {
    return here ? 'waiting for your answer' : `${from}answer here to continue`;
  }
  const left = Math.max(0, Math.ceil(Number(seconds) || 0));
  const place = here ? '' : from;
  return left > 0 ? `${place}Auto-Answering in ${left} seconds…` : `${place}Auto-Answering now…`;
}

/**
 * The same countdown on a permission card: "Auto-Permission: Allow Once will be
 * picked in 7 seconds…". `dueAt` is the server's clock for the gate's own timeout,
 * so the number is the wait that is really running, not a fixed setting.
 */
export function permissionNote(dueAt, now = Date.now()) {
  const left = Math.max(0, Math.ceil((Number(dueAt) - Number(now)) / 1000));
  return left > 0
    ? `Auto-Permission: Allow Once will be picked in ${left} seconds… `
    : 'Auto-Permission: Allow Once will be picked now… ';
}

/**
 * The chip's tooltip, as a sentence rather than a list of labels.
 *
 * It lives here, beside the other note sentences, because the chat draws the same
 * answer in two places now: the Architect's tool card carries it as a chip, and a
 * worker's trace carries each decided permission as its own line. One sentence, one
 * function, or the two drift (10 Nov).
 */
/** The chip's tooltip, as a sentence rather than a list of labels. */
export function permissionTip(d) {
  const actor = d.role ? roleLabel(d.role) : 'The Architect';
  const action = String(d.action || '').toLowerCase();
  const target = (d.resolved && d.resolved.length ? d.resolved : d.resources || []).join(' ');
  const short = target.length > 220 ? `${target.slice(0, 217)}…` : target;
  const asks =
    action === 'read'
      ? short
        ? `read ${short}`
        : 'read a file'
      : /^(edit|write|patch|create)$/.test(action)
        ? short
          ? `change ${short}`
          : 'change a file'
        : action === 'shell' || action === 'bash'
          ? 'run a command'
          : action === 'execute'
            ? 'run code'
            : 'use a tool';
  const sentence =
    action === 'shell' && short ? `${actor} asked to run this command:\n${short}` : `${actor} asked to ${asks}.`;
  const decision =
    d.effect === 'deny'
      ? d.decidedBy === 'operator'
        ? 'You rejected it.'
        : 'The harness refused it.'
      : d.decidedBy === 'timeout'
        ? 'Full auto allowed it after the wait.'
        : d.decidedBy === 'full-auto'
          ? 'Full auto allowed it without asking.'
          : d.asked
            ? 'You allowed it.'
            : d.decidedBy === 'operator'
              ? 'You allowed this exact request earlier.'
              : 'The harness allowed it without asking.';
  // The policy sentence explains a refusal; on an allow it is usually just
  // "Reading is allowed", which says nothing the decision line does not. The
  // operator's own words, when they gave a reason, come before both — they are
  // the thing a reader is looking for after "you rejected it".
  const reason = d.effect === 'deny' && d.reason ? d.reason : '';
  const told = d.effect === 'deny' && d.note ? `You told ${actor}: ${d.note}` : '';
  return [sentence, reason, told, decision].filter(Boolean).join('\n');
}



/**
 * The permission chip itself: the one the Architect's tool card wears.
 *
 * Amber when the operator had to answer, green when the policy allowed it without
 * asking, red when it was refused — and the whole sentence, a refusal's reason
 * included, in the title. It is here rather than in the transcript so a worker's
 * trace can wear the same chip: two places, one component, exactly as the operator
 * asked ("the same exact format as for architect") (10 Nov).
 */
export function permissionChip(d) {
  if (!d || !d.effect) return '';
  const cls = d.effect === 'deny' ? 'err' : d.asked ? 'warn' : 'ok';
  return `<span class="tool-perm state-pill ${cls}" title="${esc(permissionTip(d))}">permission</span>`;
}
