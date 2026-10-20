// Session naming.
//
// Sessions are created as "TBD" because a good name only exists after the
// first answer. Once a turn succeeds we ask the model — through the engine's
// one-shot `generate` route, which does NOT join the transcript — for a short
// title and rename the session. One attempt per session, and never for a
// session the operator has already named.
import { TBD_TITLE } from './titles.js';

const TIMEOUT_MS = 45000;

// Measured in the running UI, not guessed: the title box in the rail is 145px at
// DM Sans 12.5px, and "Ambient Second Monitor" (22 characters) measures 145px —
// so 22 is what fits before the ellipsis. The CSS ellipsis stays as the
// safeguard, because a name that overflows must never push the delete button out
// of the row.
const MAX_TITLE = 22;

const titlePrompt = (firstRequest) =>
  'Write a short title for the coding session below. Rules: 3 to 5 words, ' +
  'at most 22 characters, title case, no trailing punctuation, no quotes, ' +
  'reply with the title only.\n\n' +
  `Request: ${firstRequest}`;

/** Models like to wrap answers in quotes or explain themselves; strip that. */
export function cleanTitle(raw) {
  let t = String(raw ?? '');
  t = t.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  t = t.replace(/^[#*\-\s"'`]+/, '').replace(/["'`*\s]+$/, '');
  t = t.replace(/^(title|session)\s*[:\-]\s*/i, '');
  t = t.replace(/[.:;,]+$/, '').trim();
  if (t.length > MAX_TITLE) {
    // Cut at a word boundary rather than mid-word, unless that would leave a
    // stump shorter than the cut itself.
    const head = t.slice(0, MAX_TITLE + 1);
    const space = head.lastIndexOf(' ');
    const kept = space > 8 ? head.slice(0, space) : t.slice(0, MAX_TITLE);
    t = kept.replace(/[\s\-–—,:;]+$/, '').trim();
  }
  return t;
}

export function isUnnamed(title) {
  const t = String(title ?? '').trim();
  return t === '' || t.toUpperCase() === TBD_TITLE;
}

export function createTitler({ engine, logger, notify }) {
  const log = logger.channel('session');
  // sessionId -> attempts made. Only counts attempts we actually made, so a
  // session that is not ready yet or already named is never "used up".
  const attempts = new Map();
  const MAX_ATTEMPTS = 3;
  const RETRY_MS = [6000, 20000];

  async function withTimeout(promise, ms) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function maybeTitle(sessionId, retry = 0) {
    if (!sessionId) return null;
    if ((attempts.get(sessionId) || 0) >= MAX_ATTEMPTS) return null;

    try {
      const sessions = await withTimeout(engine.listSessions(), 15000);
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return null;
      if (!isUnnamed(session.title)) return null; // the operator already decided

      const messages = await withTimeout(engine.getMessages(sessionId), 15000);
      const firstUser = messages.find((m) => m.type === 'user' && String(m.text || '').trim());
      if (!firstUser) return null; // nothing to name it from yet — do not spend an attempt

      attempts.set(sessionId, (attempts.get(sessionId) || 0) + 1);

      const text = await withTimeout(
        engine.generateText(sessionId, titlePrompt(String(firstUser.text).trim().slice(0, 600))),
        TIMEOUT_MS,
      );
      const title = cleanTitle(text);
      if (!title) return null;

      await withTimeout(engine.updateSessionTitle(sessionId, title), 15000);
      log.info(`auto-named ${sessionId} -> "${title}"`);
      notify?.(sessionId, title);
      return title;
    } catch (err) {
      // Naming is a nicety; a transient upstream failure must not burn the
      // only attempt (the engine really does answer 503 "Endpoint is
      // unavailable" now and then).
      const made = attempts.get(sessionId) || 0;
      if (isTransient(err) && made < MAX_ATTEMPTS) {
        const wait = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)];
        log.warn(`auto-name retry ${made}/${MAX_ATTEMPTS} for ${sessionId} in ${wait}ms: ${err.message}`);
        const timer = setTimeout(() => maybeTitle(sessionId, retry + 1), wait);
        timer.unref?.();
        return null;
      }
      log.warn(`auto-name skipped for ${sessionId}: ${err.message}`);
      return null;
    }
  }

  return { maybeTitle, sweep, isUnnamed, cleanTitle };

  /**
   * Name anything left unnamed — a session whose naming was skipped (the
   * engine 503'd, Synapse was restarted mid-turn) should not stay "TBD"
   * forever. Runs once at boot, gently.
   */
  async function sweep(limit = 10) {
    try {
      const sessions = await withTimeout(engine.listSessions(), 15000);
      const candidates = sessions.filter((s) => isUnnamed(s.title)).slice(0, limit);
      for (const s of candidates) {
        const messages = await withTimeout(engine.getMessages(s.id), 15000).catch(() => []);
        if (!messages.some((m) => m.type === 'user' && String(m.text || '').trim())) continue;
        await maybeTitle(s.id);
        await new Promise((r) => { const t = setTimeout(r, 1500); t.unref?.(); });
      }
    } catch (err) {
      log.warn(`auto-name sweep skipped: ${err.message}`);
    }
  }
}

/** Worth another go: upstream hiccups and timeouts, not "this will never work". */
export function isTransient(err) {
  const m = String(err?.message || err || '');
  return (
    /\b(408|429|50[0-9])\b/.test(m) ||
    /upstream|unavailable|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|network/i.test(m)
  );
}
