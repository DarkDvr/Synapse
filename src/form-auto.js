// Full auto for questions: the forms half of the switch.
//
// The engine raises a form and waits for a reply; the page shows the panel. When
// the operator is away and "Full auto" is on, this answers the form after the
// same minute the permission gate waits: the recommended option, or the top one.
// It polls rather than listens because forms have no event Synapse sees; the
// server calls `tick()` every few seconds, so a closed browser cannot stop it.
//
// The flag lives in the session metadata (`synapse.fullAuto`). It is read once
// per session and kept current by `setFullAuto`; a session saved with the old
// `permissionTimeout` name is still honoured.
import { autoAnswerFor, FULL_AUTO_MS } from './auto-answer.js';

export function createFormAuto({ engine, logger, onAnswered, timeoutMs = FULL_AUTO_MS, now = Date.now } = {}) {
  const log = logger?.channel?.('app');
  const fullAuto = new Set();
  const checked = new Set();
  const seen = new Map(); // formId -> { at, sessionId }
  const settled = new Set(); // answered here, or failed once; cleared when the form goes

  function setFullAuto(sessionId, on) {
    if (!sessionId) return false;
    if (on) fullAuto.add(sessionId);
    else fullAuto.delete(sessionId);
    return true;
  }

  /** Is full auto on for this session? Asked once per session, then remembered. */
  async function enabledFor(sessionId) {
    if (fullAuto.has(sessionId)) return true;
    if (checked.has(sessionId)) return false;
    checked.add(sessionId);
    try {
      const session = await engine.getSession(sessionId);
      const synapse = session?.metadata?.synapse || {};
      if (synapse.fullAuto === true || synapse.permissionTimeout === true) {
        fullAuto.add(sessionId);
        return true;
      }
    } catch (err) {
      log?.warn(`full auto could not read ${sessionId}: ${err.message}`);
    }
    return false;
  }

  let busy = false;

  /**
   * One sweep. A form is remembered from the first time it is seen and answered
   * when it has been waiting `timeoutMs`. A failed reply is not retried every
   * few seconds: the card is still the operator's, and the form disappearing
   * clears the mark. A second sweep is skipped while one is in flight, so a slow
   * engine cannot have the same form answered twice.
   */
  async function tick() {
    if (busy) return { answered: 0, waiting: 0, busy: true };
    busy = true;
    try {
    let forms;
    try {
      forms = await engine.listForms();
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
      if (now() - seen.get(id).at < timeoutMs) {
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
        log?.info(`full auto answered ${sessionId}/${id} after ${Math.round(timeoutMs / 1000)}s`);
        try {
          await onAnswered?.({ form, sessionId, answer });
        } catch (err) {
          log?.warn(`full auto answered, but the record failed: ${err.message}`);
        }
      } catch (err) {
        settled.add(id);
        log?.warn(`full auto could not answer ${sessionId}/${id}: ${err.message}`);
      }
    }
    return { answered, waiting };
    } finally {
      busy = false;
    }
  }

  return { tick, setFullAuto, enabledFor };
}
