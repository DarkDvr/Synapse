// What the finished-work chime is allowed to say.
//
// The sound means one thing: "the Architect has finished, nothing is running, and the
// chat is waiting for you." Two questions decide it, and both are easy to get wrong in
// the page's own state, so they live here — pure, and tested without a browser.
//
// It went wrong once (31 Oct): a coder's run ended at 14:11:35 and the next task did
// not start until 14:12:09, because the Architect's turn in between — reading the
// report, marking the task done — takes time. In that gap nothing was working, but the
// job was not finished either, and the chime said it was.

/** The finished-work sounds that exist in `web\sounds`, plus "off". The names are the
 *  file names, and `src/config.js` accepts exactly this list. */
export const DONE_SOUNDS = [
  { v: 'off', l: 'Off' },
  { v: 'chime', l: 'Chime — two soft notes' },
  { v: 'bell', l: 'Bell — one struck note' },
  { v: 'wood', l: 'Wood — a quiet knock' },
  { v: 'ripple', l: 'Ripple — three light plips' },
];

/** What the config chooses when the key is missing (a config from an older build). */
export const DONE_SOUND_DEFAULT = 'chime';

/** A known name, or the default — never a file that does not exist. */
export const doneSoundName = (value) => (DONE_SOUNDS.some((s) => s.v === value) ? value : DONE_SOUND_DEFAULT);

/**
 * Will the harness pick this up again by itself?
 *
 * Only in Multi, only with Keep running on, and only when the plan still has a row to
 * do. Then the chat is *between* two pieces of work: a worker reported, and the
 * Architect will start the next task in a moment. That gap is not "done", and chiming
 * in it was the bug.
 *
 * A blocked task is deliberately not "to do": the run stopped for the operator, which
 * is exactly the moment the sound is for.
 *
 * @param {{mode?: string, auto?: boolean, tasks?: Array<{status?: string}>}} state
 */
export function workWillContinue({ mode = 'single', auto = false, tasks = [] } = {}) {
  if (mode !== 'multi') return false;
  if (auto !== true) return false;
  return (Array.isArray(tasks) ? tasks : []).some((t) => t && (t.status === 'todo' || t.status === 'doing'));
}
