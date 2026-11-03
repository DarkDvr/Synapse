// Auto-Answer: the forms half of the automation switches.
//
// The engine raises a form and waits for a reply; the page shows the panel. When
// the project has Auto-Answer on and the operator is away, this answers the form
// after the wait in Settings → Automation (`automation.answerSec`): the
// recommended option, or the top one. Zero means answer on the next sweep, with
// no wait. It polls rather than listens because forms have no event Synapse sees;
// the server calls `tick()` every few seconds, so a closed browser cannot stop it.
//
// The switch lives in the session metadata (`synapse.automation.autoAnswer`), read
// through src/automation.js so a chat saved under the older `fullAuto` name keeps
// its behaviour.
import { autoAnswerFor, FULL_AUTO_MS } from './auto-answer.js';
import { readAutomation } from './automation.js';

export function createFormAuto({
  engine,
  logger,
  onAnswered,
  // Where the pending forms come from. The default asks the engine once, which is
  // scoped by the request's directory and therefore empty for Synapse; the server
  // passes a provider that asks every session (src/api.js). See docs/notes.
  listForms = null,
  timeoutMs = FULL_AUTO_MS,
  getTimeoutMs = null,
  now = Date.now,
} = {}) {
  const log = logger?.channel?.('app');
  const fullAuto = new Set();
  // The project's explicit answer, from the chat the operator flipped. A worker's
  // form is in the same directory, and its own session metadata does not carry
  // the switch; `true`/`false` here decides before that metadata is consulted.
  const fullAutoDirs = new Map();
  const dirOf = new Map();
  const checked = new Set();
  const seen = new Map(); // formId -> { at, sessionId }
  const settled = new Set(); // answered here, or failed once; cleared when the form goes

  /** The current wait, read on every sweep so a Settings change applies without
   *  a restart. Zero is valid and means "answer at once". */
  const waitMs = () => {
    const fallback = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : FULL_AUTO_MS;
    if (!getTimeoutMs) return fallback;
    const ms = Number(getTimeoutMs());
    // A broken setting must not silently answer every question at once.
    return Number.isFinite(ms) ? Math.max(0, ms) : fallback;
  };

  const dirKey = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

  function setAutoAnswer(sessionId, on, directory = '') {
    if (!sessionId && !directory) return false;
    if (sessionId) {
      if (on) fullAuto.add(sessionId);
      else fullAuto.delete(sessionId);
    }
    const known = directory || dirOf.get(sessionId) || '';
    if (known) fullAutoDirs.set(dirKey(known), Boolean(on));
    // A worker that already read the switch on must not keep answering after the
    // operator turns it off: the project's answer is the later word.
    if (!on && known) {
      for (const [id, dir] of dirOf) if (dirKey(dir) === dirKey(known)) fullAuto.delete(id);
    }
    return true;
  }

  /** The four switches, from the API. Only Auto-Answer matters to this module; the
   *  other three are ignored so one call site can carry all four. */
  function setAutomation(sessionId, automation, directory = '') {
    return setAutoAnswer(sessionId, automation?.autoAnswer === true, directory);
  }

  /** The old name, kept for callers and tests written before the four switches:
   *  "Full auto" answered questions, so it is Auto-Answer. */
  const setFullAuto = (sessionId, on, directory = '') => setAutoAnswer(sessionId, on, directory);

  /** Is Auto-Answer on for this session? The project's explicit switch first, then
   *  the session's own saved metadata, asked once and remembered. */
  async function enabledFor(sessionId) {
    const known = dirOf.get(sessionId);
    if (known) {
      const chosen = fullAutoDirs.get(dirKey(known));
      if (chosen !== undefined) return chosen;
    }
    if (fullAuto.has(sessionId)) return true;
    if (checked.has(sessionId)) return false;
    try {
      const session = await engine.getSession(sessionId);
      // Marked only once the engine has answered. The snapshot asks this to label
      // the question panel, so a read that failed would otherwise be remembered as
      // "off" for the rest of the run — and one blip would leave a chat's questions
      // unanswered while the panel promised an answer.
      checked.add(sessionId);
      const directory = session?.directory || '';
      if (directory) {
        dirOf.set(sessionId, directory);
        const chosen = fullAutoDirs.get(dirKey(directory));
        if (chosen !== undefined) return chosen;
      }
      // The session's own automation first, with the old `fullAuto` name as the
      // fallback for a chat saved before the four switches (src/automation.js).
      if (readAutomation(session).autoAnswer === true) {
        fullAuto.add(sessionId);
        return true;
      }
    } catch (err) {
      log?.warn(`auto-answer could not read ${sessionId}: ${err.message}`);
    }
    return false;
  }

  let busy = false;

  /**
   * One sweep. A form is remembered from the first time it is seen and answered
   * when it has been waiting the configured wait. A failed reply is not retried
   * every few seconds: the card is still the operator's, and the form
   * disappearing clears the mark. A second sweep is skipped while one is in
   * flight, so a slow engine cannot have the same form answered twice.
   */
  async function tick() {
    if (busy) return { answered: 0, waiting: 0, busy: true };
    busy = true;
    try {
    let forms;
    try {
      forms = listForms ? await listForms() : await engine.listForms();
    } catch {
      return { answered: 0, waiting: 0 };
    }
    const live = new Set();
    for (const form of forms || []) if (form?.id) live.add(form.id);
    for (const id of [...seen.keys()]) {
      if (live.has(id)) continue;
      seen.delete(id);
      settled.delete(id);
    }

    let answered = 0;
    let waiting = 0;
    for (const form of forms || []) {
      const id = form?.id;
      const sessionId = form?.sessionID;
      if (!id || !sessionId) continue;
      if (!seen.has(id)) seen.set(id, { at: now(), sessionId });
      if (settled.has(id)) continue;
      if (!(await enabledFor(sessionId))) continue;
      const wait = waitMs();
      if (wait > 0 && now() - seen.get(id).at < wait) {
        waiting += 1;
        continue;
      }
      const answer = autoAnswerFor(form);
      if (!answer) {
        settled.add(id);
        continue;
      }
      try {
        await engine.replyForm(sessionId, id, answer);
        settled.add(id);
        answered += 1;
        log?.info(
          wait > 0
            ? `auto-answer answered ${sessionId}/${id} after ${Math.round(wait / 1000)}s`
            : `auto-answer answered ${sessionId}/${id} immediately`,
        );
        try {
          await onAnswered?.({ form, sessionId, answer });
        } catch (err) {
          log?.warn(`auto-answer answered, but the record failed: ${err.message}`);
        }
      } catch (err) {
        settled.add(id);
        log?.warn(`auto-answer could not answer ${sessionId}/${id}: ${err.message}`);
      }
    }
    return { answered, waiting };
    } finally {
      busy = false;
    }
  }

  return { tick, setFullAuto, setAutoAnswer, setAutomation, enabledFor };
}
