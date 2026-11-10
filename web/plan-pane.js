// The plan pane: the work list the Architect keeps in the project's
// `.synapse/plan.json`, drawn as rows with a status, a role and a clock.
//
// The file is the source of truth. This module renders it and says plainly when the
// file is malformed rather than hiding the problem; nothing here decides a status.
//
// Three things come from app.js and are wired at boot: the clock formatter, the
// chime's "is work still coming?" answer, and the role cards' activity (a plan row
// and a card are two views of the same worker).
import { state } from './state.js';
import { esc, hhmmss, ago } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { currentRun } from './run-view.js';
import { orderPlan, parentOf } from './plan-order.js';

const missing = (name) => () => {
  throw new Error(`plan-pane.js: ${name} was not wired at boot`);
};
const wired = {
  noteWorking: missing('noteWorking'),
  renderRoleActivity: missing('renderRoleActivity'),
};

/** Hand this module the two things that live in app.js. Called once, at boot. */
export function planPaneWiring(fns) {
  Object.assign(wired, fns);
}

// ── the project plan ────────────────────────────────────────────
// `.synapse\plan.json` in the session's project folder, written by the Architect
// and read here. The file is the source of truth: this pane only renders it, and
// says so plainly when the file is malformed rather than hiding the problem.
export const PLAN_STATUS = {
  todo: 'Todo',
  doing: 'Doing',
  // Not a plan file status: a step whose worker has reported and whose result the
  // Architect has not judged yet. See renderPlan.
  review: 'Reported, waiting for review',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
};

export async function loadPlan() {
  // Same rule as loadMessages: the chat can change while this is in flight, and
  // the plan belongs to the chat. A late answer for the previous chat used to
  // paint "No plan yet" over a project that has a plan.
  const id = state.sessionId;
  if (!id) {
    state.planState = null;
    renderPlan();
    wired.renderRoleActivity();
    return;
  }
  try {
    const loaded = await api('GET', `/api/sessions/${encodeURIComponent(id)}/plan`);
    if (state.sessionId !== id) return;
    state.planState = loaded;
  } catch {
    if (state.sessionId !== id) return;
    state.planState = null;
  }
  renderPlan();
  // The cards read the plan too: which roles have taken part, which are blocked,
  // and whether the whole thing is finished. Without this a status change would
  // only reach the dots on the next run or session event.
  wired.renderRoleActivity();
  // The plan is half the answer to "is this chat done?": while it still had a task to
  // do, the chime was held back. The moment it catches up, the sound is due.
  wired.noteWorking();
}

export function renderPlan() {
  const body = $('planBody');
  if (!body) return;
  paintPlan(body);
  updatePlanOverflow();
}

/** The plan box is as tall as the role cards, so a long plan is routinely cut
 *  mid-row. Mark the panel while there is more below the fold, so its bottom
 *  edge fades instead of drawing a hard line through a card. */
export function updatePlanOverflow() {
  const body = $('planBody');
  const panel = body?.closest('.rail-plan');
  if (!body || !panel) return;
  const more = body.scrollHeight - body.scrollTop - body.clientHeight > 2;
  panel.classList.toggle('is-clipped', more);
}

export function paintPlan(body) {
  const st = state.planState;
  const rel = st?.relative || '.synapse\\plan.json';

  // Single mode is a chat, not a run: there are no roles and no work list, so the
  // panel says what the conversation is about and how long it has run, and nothing
  // else. It is short on purpose — the card beside it is the subject.
  if (state.mode === 'single') {
    const goal = String(st?.plan?.goal || '').trim();
    body.innerHTML =
      `<p class="plan-goal plan-goal-single">${goal ? esc(goal) : 'A conversation with the Architect: it answers here, with no workers and no list.'}</p>` +
      `<p class="rail-note plan-meta"><span></span>${planClockMarkup()}</p>`;
    return;
  }

  // A file we cannot read is the Architect's to fix, so say exactly what is
  // wrong and where, rather than showing an empty pane.
  if (st?.error) {
    body.innerHTML =
      `<p class="plan-error">${esc(st.error)}</p>` +
      `<p class="rail-note plan-meta"><span>${esc(rel)}</span>${planClockMarkup()}</p>`;
    return;
  }

  const tasks = st?.plan?.tasks || [];
  // Read in the plan's own shape: a root keeps its place and its `t2a`/`t2b` children
  // follow it, wherever the Architect appended them. Counts still use the file's own
  // list — ordering is a view, not a rewrite.
  const shownTasks = orderPlan(tasks);
  const planIds = tasks.map((t) => String(t.id || '')).filter(Boolean);
  // A task with a worker on it is the step in hand whatever the file says. The
  // Architect only writes the plan when it judges, so during the run the file
  // still says todo and the pane showed the live step as a grey row. The run is
  // the live truth; the file stays the plan.
  const liveRun = currentRun();
  if (!tasks.length) {
    body.innerHTML =
      `<p class="rail-note">No plan yet. Ask the Architect to plan this job - it owns ${esc(rel)}.</p>` +
      `<p class="rail-note plan-meta"><span></span>${planClockMarkup()}</p>`;
    return;
  }

  const counts = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  // The line has to fit a 300px rail beside the session clock, so it carries the
  // three facts that change and nothing else: how far the plan got, how much is
  // running, how much is blocked. "done" rides on the fraction only when the
  // plan is finished (it then says the job is closed); the plan's age moved into
  // the tooltip, where it costs no width.
  const done = counts.done || 0;
  const meta = [done === tasks.length ? `${done}/${tasks.length} done` : `${done}/${tasks.length}`];
  if (counts.doing) meta.push(`${counts.doing} running`);
  if (counts.blocked) meta.push(`${counts.blocked} blocked`);
  if (counts.failed) meta.push(`${counts.failed} failed`);
  const metaTitle = `${done} of ${tasks.length} tasks done${st.mtime ? `; the plan changed ${ago(st.mtime)}` : ''}`;

  // Work already spent on each step, from the harness's own run records. A step
  // with a worker on it keeps counting from the live run's start.
  const spent = st.spent || {};
  // Steps whose worker has reported and whose result the Architect has not
  // written back yet (see the plan route).
  const reported = new Set(st.reported || []);
  body.innerHTML =
    // The goal paragraph is gone: the operator never read it, and the list is
    // what the rail is for. The goal still lives in the project document.
    `<ol class="plan-list">${shownTasks
      .map((t) => {
        const status = liveRun && liveRun.task === t.id ? 'doing' : PLAN_STATUS[t.status] ? t.status : 'todo';
        // Between the worker's result and the Architect's judgement the plan file
        // still says `todo`, but the step is not untouched: it is in review. Shown
        // as `review` so the row keeps a mark of its own instead of dropping back
        // to grey, which read as a revert.
        const shown = status === 'todo' && reported.has(t.id) ? 'review' : status;
        // The result is not printed under the title: the row stays one line per
        // task, and the detail is a hover away. A blocked note is the exception —
        // that one is the reason the operator is being asked, so it shows.
        //
        // Only while it *is* the reason: a note on a task that is done, or back to
        // todo, is the Architect having moved on without clearing its own note, and
        // showing it made a finished plan look like it was still asking. The file
        // keeps the text (the Architect owns it) — this is just what the pane shows.
        const asking = status === 'blocked' || status === 'failed';
        const tooltip = [t.title, t.result ? `Result: ${t.result}` : '', t.note ? `Note: ${t.note}` : '']
          .filter(Boolean)
          .join('\n\n');
        // The step's own stopwatch: what the harness recorded for it, plus this
        // run so far while it is in hand. Under the role badge, so the row is two
        // lines tall whatever the title does.
        const base = Number(spent[t.id]) || 0;
        const since = liveRun && liveRun.task === t.id ? Number(liveRun.startedAt) || 0 : 0;
        const total = base + (since ? Date.now() - since : 0);
        // A finished row with no time was settled, not run: the QC cap, a task the
        // Architect marked done itself. The zero-time rule hid the clock, which read
        // as a timer that failed to appear; "not run" is the fact.
        const settled = total === 0 && (shown === 'done' || shown === 'blocked' || shown === 'failed');
        const spentText = settled ? 'not run' : hhmmss(total);
        const spentClass = settled ? ' is-none' : total ? '' : ' is-zero';
        const spentTitle = settled
          ? 'No worker ran this step — the Architect settled it itself.'
          : 'Time spent on this step so far';
        const child = parentOf(t.id, planIds) ? ' is-child' : '';
        return `<li class="plan-task${child}" data-status="${shown}">
          <span class="plan-node">
            <span class="plan-dot" role="img" aria-label="${esc(PLAN_STATUS[shown])}"></span>
            <span class="plan-id">${esc(t.id || '?')}</span>${
              t.origin === 'found'
                ? `<span class="plan-origin" title="Noticed during the work - this row was not in the list when the operator first saw it">NEW</span>`
                : ''
            }
          </span>
          <span class="plan-main">
            <span class="plan-title" title="${esc(tooltip)}">${esc(t.title)}</span>
            ${t.note && asking ? `<span class="plan-note">${esc(t.note)}</span>` : ''}
          </span>
          <span class="plan-side">
            <span class="plan-role">${esc(t.role)}</span>
            <span class="plan-spent${spentClass}" data-ms="${base}"${
              since ? ` data-since="${since}"` : ''
            }${settled ? ' data-settled="1"' : ''} title="${esc(spentTitle)}">${spentText}</span>
          </span>
        </li>`;
      })
      .join('')}</ol>` +
    // The plan's complaints are for the Architect, not the operator: they name
    // feature ids, task ids and file paths, and every one of them is something
    // the Architect is already being told to fix in its own instruction block.
    // Printing them here put four lines of housekeeping under the operator's
    // plan and asked them to care about a job that was not theirs. The log keeps
    // them (`logPlanState`), which is where a run is read afterwards.
    `<p class="rail-note plan-meta"><span title="${esc(metaTitle)}">${esc(meta.join(' · '))}</span>${planClockMarkup()}</p>`;
}

/** The session's own stopwatch, in the plan footer: time spent working, paused
 *  whenever the cards show nobody working. It is rendered here so a plan poll
 *  repaints it with the right value instead of zeroing it. */
export function planClockMarkup() {
  const c = state.clocks;
  if (!c) return '';
  const ms = c.session.ms + (c.session.since ? Date.now() - c.session.since : 0);
  return `<span class="plan-clock" id="planClock" title="Time this chat has spent working — it pauses whenever no card is working, and whenever you are being waited on.">${hhmmss(ms)}</span>`;
}

/**
 * A popup opened from the rail's foot.
 *
 * The two tables used to render into panels under the conversation; the ids and
 * the renderers are unchanged, so opening one is: show the backdrop, then let the
 * caller refresh what is inside it. Closing is the same in reverse, and the
 * refresh is skipped when the panel is not on screen.
 */
