// Full auto for questions: the forms half of the switch.
//
// The engine raises a form and waits for a reply; the page shows the panel. When
// the operator is away and "Full auto" is on, this answers the form after the
// wait in Settings → Workers (`fullAuto.timeoutSec`): the recommended option, or
// the top one. Zero means answer on the next sweep, with no wait. It polls rather
// than listens because forms have no event Synapse sees; the server calls
// `tick()` every few seconds, so a closed browser cannot stop it.
//
// The flag lives in the session metadata (`synapse.fullAuto`). It is read once
// per session and kept current by `setFullAuto`; a session saved with the old
// `permissionTimeout` name is still honoured.
import { autoAnswerFor, FULL_AUTO_MS } from './auto-answer.js';

export function createFormAuto({
  engine,
  logger,
  onAnswered,
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

  function setFullAuto(sessionId, on, directory = '') {
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

  /** Is full auto on for this session? The project's explicit switch first, then
   *  the session's own saved metadata, asked once and remembered. */
  async function enabledFor(sessionId) {
    const known = dirOf.get(sessionId);
    if (known) {
      const chosen = fullAutoDirs.get(dirKey(known));
      if (chosen !== undefined) return chosen;
    }
    if (fullAuto.has(sessionId)) return true;
    if (checked.has(sessionId)) return false;
    checked.add(sessionId);
    try {
      const session = await engine.getSession(sessionId);
      const directory = session?.directory || '';
      if (directory) {
        dirOf.set(sessionId, directory);
        const chosen = fullAutoDirs.get(dirKey(directory));
        if (chosen !== undefined) return chosen;
      }
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
            ? `full auto answered ${sessionId}/${id} after ${Math.round(wait / 1000)}s`
            : `full auto answered ${sessionId}/${id} immediately`,
        );
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
