// A delegated run, as the page shows it: its state, the cards, the path between them.
//
// The runner broadcasts a run's whole life (run.started → run.progress →
// run.finished) and serves the same shape at GET /api/runs, so a page opened mid-run
// starts from the truth rather than from an idle screen. One worker per project at a
// time, so a project has at most one live run — and this module is where those events
// become the cards: who is working, on what, for how long, at what speed, and what the
// last thing they said was.
//
// Two things come from app.js and are wired at boot: the cards' layout (they move
// when the stage does) and the desk badge.
import { state } from './state.js';
import { esc, shortSpan, fmtBytes, hhmm } from './format.js';
import { $ } from './dom.js';
import { api } from './api.js';
import { toast } from './toast.js';
import { dirKey, currentRun, currentProject, roleLabel, modelByRef, selectionFor, groupTurns } from './run-view.js';
import { findSession, isBusy, renderTree } from './projects.js';
import { renderPlan } from './plan-pane.js';
import { renderTranscript } from './transcript.js';
import { chatScroller, foldStream, renderChatNav } from './chat-scroll.js';
import { paneEnded } from './thinking-pane.js';
import { noteCompaction, noteLoop, steerNotes, traceFor, traceKeyOf, traceOf } from './traces.js';
import { noteLease } from './chat-notes.js';
import { paintRates, resetRate } from './rate-view.js';
import { reconcileRuns } from './runs-sync.js';
import { renderComposer } from './composer.js';
import { toolTarget } from './format.js';

const missing = (name) => () => {
  throw new Error(`live-runs.js: ${name} was not wired at boot`);
};
const wired = {
  applyRoleCardsLayout: missing('applyRoleCardsLayout'),
  renderDesk: missing('renderDesk'),
};

/** Hand this module the two things that live in app.js. Called once, at boot. */
export function liveRunsWiring(fns) {
  Object.assign(wired, fns);
}

// ── live delegated work ─────────────────────────────────────────
// The runner broadcasts a run's whole life (`run.started` → `run.progress` →
// `run.finished`) and serves the same shape at `GET /api/runs`, so a page opened
// mid-run starts from the truth rather than from an idle screen. One worker per
// project at a time, so a project has at most one live run.

/** The first sentence of a provider error, short enough for one card line. The
 *  full sentence rides the slot's tooltip, like every other card text. */
const shortErr = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const first = t.split(/(?<=[.!?])\s/)[0] || t;
  return first.length > 92 ? `${first.slice(0, 91)}…` : first;
};

/** A tool call as the card's phrase: "writing calendar.py". */
export function runPhrase(tool) {
  const name = String(tool?.name || '');
  const target = String(tool?.target || '');
  const file = target.split(/[\\/]/).filter(Boolean).pop() || '';
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  switch (name) {
    case 'write': return file ? `writing ${file}` : 'writing a file';
    case 'edit': return file ? `editing ${file}` : 'editing a file';
    case 'read': return file ? `reading ${file}` : 'reading';
    case 'shell': return target ? `running ${target}` : 'running a command';
    case 'grep':
    case 'glob': return file ? `searching ${file}` : 'searching';
    case 'webfetch': return 'fetching a page';
    case 'skill': return file ? `using ${file}` : 'loading a skill';
    case 'subagent': return 'delegating';
    // The harness's own delegate tool is named after the function it registers;
    // the card should say what the Architect is doing, not the tool's id (9 Nov).
    case 'synapse-delegate_delegate': return 'delegating';
    case 'question': return 'asking the operator';
    default: return name || 'working';
  }
}

/** The newest tool call in the *running* turn — the Architect's own activity while
 *  its turn is running (a worker's comes from the runner instead).
 *
 *  Only the turn after the newest `idle` boundary counts. Reading the whole
 *  transcript put the previous turn's delegate call on the card while the Architect
 *  was already thinking again, so the status read "synapse-delegate_delegate" for a
 *  turn that had called nothing yet (9 Nov). */
export function latestToolIn(messages) {
  const list = messages || [];
  let from = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.type === 'idle') {
      from = i + 1;
      break;
    }
  }
  let found = null;
  for (const m of list.slice(from)) {
    for (const p of m?.parts || []) {
      if (p?.type === 'tool' && p.name) found = { name: String(p.name), target: toolTarget(p) };
    }
  }
  return found;
}

/** The card a role owns. The role id lives on its model select, which the picker
 *  code already treats as the source of truth for which card is whose. */
const cardFor = (role) => {
  const sel = document.querySelector(`#topology .role-model[data-role="${CSS.escape(String(role || ''))}"]`);
  return sel ? sel.closest('.role-card') : null;
};

/**
 * Give every card a role id and a subtitle slot.
 *
 * The ids are read off the cards' own model selects rather than written into the
 * markup a second time: one source of truth per role, and a card added to
 * index.html gets its slot without anyone remembering to add one.
 */
export function initRoleCards() {
  for (const card of document.querySelectorAll('#topology .role-card')) {
    const sel = card.querySelector('.role-model[data-role]');
    if (sel) card.dataset.role = sel.dataset.role;
    if (!card.querySelector('.role-task')) {
      const slot = document.createElement('p');
      slot.className = 'role-task';
      card.append(slot);
    }
    // The verdict chip (DONE / WAITING ON YOU) belongs beside the name, not in the
    // text slot: in the slot it took the first of the Architect's three lines and
    // left the two that were left for one line of summary. Created here rather
    // than in index.html so a card added there gets its holder without a second
    // edit, the same way the text slot above does.
    if (!card.querySelector('.role-chip')) {
      const hold = document.createElement('span');
      hold.className = 'role-chip';
      card.querySelector('.role-head h3')?.after(hold);
    }
  }
}

/**
 * What every card is doing right now, and what state its role is in.
 *
 * One derivation, three things read off it: the **dot** (taking part / blocked /
 * idle but has taken part / never taken part), the card's **opacity** (a role
 * that has never been in this plan is dimmed to 80%), and the **subtitle** (who
 * the Architect is waiting on, what a worker is doing to its task, or that the
 * operator is the one being waited on).
 *
 * All of it is derived from state we already hold — the plan file, the runs the
 * runner serves, the open session's turn, the pending form — so nothing is
 * stored, a reload and a restart show the same picture, and a new plan (whose
 * tasks are all `todo` again) puts every card back to 80% by itself.
 *
 * Precedence per role: running → blocked (only while the plan is stuck on it) →
 * done → idle.
 */
export function renderRoleActivity() {
  const run = currentRun();
  // `isBusy` is the engine's own list, which the pending poll rewrites every few
  // seconds; `state.busy` is this page's own word for "this session's turn is
  // running", set on executionStarted and cleared when the turn ends. The bar needs
  // both: in Single the Architect's card is the only thing that can show the work,
  // and it sat still through every turn because the list had not caught up (10 Nov).
  const archBusy = isBusy(state.sessionId) || state.busy;
  const archTool = archBusy ? latestToolIn(state.messages) : null;
  const form = (state.forms || [])[0] || null;
  const tasks = state.planState?.plan?.tasks || [];
  // The plan is finished when there is one and nothing in it is outstanding.
  const planFinished = tasks.length > 0 && tasks.every((t) => t.status === 'done');
  const unfinished = tasks.some((t) => t.status !== 'done');
  const rows = [];
  let sig = '';

  for (const card of document.querySelectorAll('#topology .role-card')) {
    const role = card.dataset.role;
    const mine = tasks.filter((t) => t.role === role);
    // "Has been used this session" — the server answers it from the run log, scoped
    // to the open session, so it survives a plan rewrite and a page reload and
    // starts over in a new session. Per the operator: a role card is about whether
    // this role was used for anything in this session, ever.
    const participated = (state.planState?.used || []).includes(role);
    const blockedTasks = mine.filter((t) => t.status === 'blocked' || t.status === 'failed');
    // Blocked is the harness actually being stuck: nobody is running, the Architect
    // is not mid-turn, and nothing else in the plan can proceed. An old blocked task
    // that the role has long since worked past is history, not the card's current
    // state — during the Architect's turn the red used to stay up for the whole turn
    // (4 Nov: "it's doing other work").
    const doneTaskIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    const anyReady = tasks.some(
      (t) => t.status === 'todo' && (Array.isArray(t.dependsOn) ? t.dependsOn : []).every((d) => doneTaskIds.has(d)),
    );
    const blocked = blockedTasks.length > 0 && !archBusy && !run && !anyReady;
    // A role whose *current* model the provider has already refused keeps its mark
    // after the run: the run is over, the dead model is still selected. It clears
    // the moment the role points at another model, or the operator clears the badge.
    const pickerValue = card.querySelector('.role-model')?.value || selectionFor(role).ref;
    const refused = pickerValue
      ? (modelByRef(pickerValue)?.issues || []).find((i) => i.kind === 'provider')
      : null;
    const skipReason = run?.skipped?.find((s) => s.role === role)?.message || refused?.message || null;

    let text = '';
    let part = '';
    let dot = 'idle';
    let chip = null;
    let skipped = false;
    // "Settled" is the Architect's resting state — finished, or waiting for the
    // operator to move. Its border goes green, the same colour every other card
    // uses for "idle, has taken part": there is nothing of ours in flight.
    let settled = false;

    if (role === 'architect') {
      // The Architect's own question first: the operator is the one being waited
      // on, and that outranks anything else the card could say.
      if (form && form.sessionId === state.sessionId) { text = 'Waiting on your answer'; dot = 'live'; }
      else if (run) { text = `Waiting on ${roleLabel(run.role)}`; part = 'initiator'; dot = 'live'; }
      else if (archBusy) { text = archTool ? runPhrase(archTool) : 'Thinking'; part = 'initiator'; dot = 'live'; }
      // Every task is done: the chip says so, and under it the Architect's own
      // one-sentence, customer-facing summary of what was built.
      else if (planFinished) {
        const summary = state.planState?.plan?.summary || '';
        text = summary || 'Plan complete';
        chip = { cls: 'role-done', text: 'Done' };
        dot = 'ok';
        settled = true;
      }
      // Nothing in flight and work outstanding: the move is the operator's, so
      // the card says it in the same place a worker's task line would be, and
      // names the task that is ready. Without that, a plan stalled by the
      // Keep Building rule read as "waiting on you" for no stated reason — and
      // the Architect's own last line said it had queued the task (28 Oct).
      else if (unfinished) {
        const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
        const ready = tasks.find(
          (t) =>
            t.status === 'todo' &&
            (Array.isArray(t.dependsOn) ? t.dependsOn : []).every((d) => doneIds.has(d)),
        );
        // Nothing ready but something blocked: the move is still the operator's,
        // and naming the blocked task is the difference between "waiting on you"
        // and a list they can act on.
        const stuck = ready ? null : tasks.find((t) => t.status === 'blocked' || t.status === 'failed');
        text = ready
          ? `Waiting on you — ${ready.id} is ready${state.automation?.keepBuilding ? '' : ' and Keep Building is off'}`
          : stuck
            ? `Waiting on you — ${stuck.id} is ${stuck.status}`
            : 'Waiting on you';
        chip = { cls: 'role-waiting', text: 'Waiting on you' };
        dot = 'ok';
        settled = true;
      }
      // A chat with no plan has nothing outstanding once its turn has ended. The
      // card says Done, green, rather than sitting blank — the same chip a
      // finished plan gets, so "done" means the same thing in both.
      else if (!tasks.length && (state.messages || []).length) {
        text = 'Done';
        chip = { cls: 'role-done', text: 'Done' };
        dot = 'ok';
        settled = true;
      }
    } else if (run && run.role === role) {
      // A worker stopped on a question is not working on its task, whatever the
      // newest tool call was — it is waiting, exactly like the Architect does.
      const asking = form && form.sessionId !== state.sessionId;
      text = asking ? `Waiting on your answer (${run.title})` : `${run.title}${run.tool ? ` (${runPhrase(run.tool)})` : ''}`;
      part = 'worker';
      dot = 'live';
    } else if (skipReason) {
      // This role was tried for the task and the model refused it, or its current
      // model is still marked as refused. Mark it the way a blocker is marked: red
      // border, red label, and a red picker, because the model is what failed and
      // swapping it is the fix. It outlives the run on purpose — the dead model is
      // still selected after the report.
      skipped = true;
      text = `Skipped — ${skipReason}`;
    } else if (blocked) {
      // A blocked task is not a crashed card: red is the blocker's colour, and
      // an unexplained red card read as "the Designer errored" (28 Oct). Name
      // the task; the reason is on its plan row.
      dot = 'err';
      const stuck = blockedTasks[0];
      text = stuck ? `Blocked — ${stuck.title}` : 'Blocked';
    }
    else if (participated) dot = 'ok';

    // A provider failure is *news*, shown as red text while it lasts. The border
    // keeps its own meaning — blocked, live, settled — so an error never borrows
    // it. The live run's own retry state is the freshest source; `roleErrors`
    // covers the Architect's wake, which happens after the run is gone.
    const cardErr =
      (run && run.role === role && run.retry) ||
      state.roleErrors.get(`${dirKey(currentProject()?.directory)}|${role}`) ||
      null;
    if (cardErr) {
      const at = Number(cardErr.at) || 0;
      // The engine's own sentence is jargon ("Compaction produced no summary").
      // The card says what happened; the log keeps the exact words.
      const head = /compaction produced no summary|compaction\.failed/i.test(String(cardErr.message || ''))
        ? 'Summarising the conversation failed'
        : shortErr(cardErr.message);
      text = cardErr.retrying !== false && at ? `Retrying at ${hhmm(at)} — ${head}` : head;
    }

    // Dimmed cards are the ones that have never been in this session at all. A
    // card that is taking part is solid by definition, and the Architect is never
    // dimmed: it is the role that exists before any of this. A skipped card is
    // solid too — it is news, not absence.
    //
    // A card carrying a clock is never dimmed either: the clock is this session's
    // own time for that role's tasks, so it is proof the role worked. The two
    // together (a timer on a faded card) was the operator's 27 Oct complaint, and
    // it was the run log being summed across sessions that produced it.
    const workedHere = mine.some((t) => Number(state.planState?.spent?.[t.id]) > 0);
    const dim = role !== 'architect' && !participated && !part && !skipped && !workedHere;
    const working =
      role === 'architect'
        ? archBusy && !run && !(form && form.sessionId === state.sessionId)
        : Boolean(run && run.role === role && !(form && form.sessionId !== state.sessionId));
    rows.push({ card, text, part, dot, dim, chip, settled, skipped, working, err: Boolean(cardErr) });
    sig += `${role}\u0001${part}\u0001${dot}\u0001${working ? 1 : 0}\u0001${dim ? 1 : 0}\u0001${settled ? 1 : 0}\u0001${skipped ? 1 : 0}\u0001${chip ? chip.text : ''}\u0001${cardErr ? 1 : 0}\u0001${text}\u0002`;
  }

  if (sig === state.roleSig) return;
  state.roleSig = sig;

  // The cards no longer change height here — the subtitle slot is a fixed
  // three-line hole — so this is only a re-measure for safety (a raised
  // `--task-lines`, a font swap). The dock's bottom never moves: the stage has a
  // definite height, so anything that did grow would take room from the
  // transcript's top edge.
  const fromH = Math.ceil($('topologyWrap')?.getBoundingClientRect().height || 0);
  for (const { card, text, part, dot, dim, chip, settled, skipped, working, err } of rows) {
    const slot = card.querySelector('.role-task');
    // The status dot is the markup's own — it ships as `idle` and is only ever
    // changed here. Yellow breathes because it means "taking part right now",
    // and the animation is the same `dot-breathe` the sidebar's live dot uses.
    const dotEl = card.querySelector('.role-head .status-dot');
    if (dotEl) {
      dotEl.className = `status-dot ${dot}`;
      dotEl.setAttribute(
        'aria-label',
        dot === 'live' ? 'taking part' : dot === 'err' ? 'blocked' : dot === 'ok' ? 'idle, has taken part' : 'idle',
      );
    }
    card.classList.toggle('is-dim', dim);
    card.classList.toggle('is-initiator', part === 'initiator');
    card.classList.toggle('is-worker', part === 'worker');
    card.classList.toggle('is-settled', settled);
    // The working wash and the border light: only a role whose turn is actually
    // running, not one waiting on a question and not the Architect while a worker
    // holds the floor.
    card.classList.toggle('is-working', working);
    // A skipped role looks like a blocked one, and its picker says where the
    // problem is: the model, not the role.
    card.classList.toggle('is-skipped', skipped);
    card.querySelector('.model-search')?.classList.toggle('is-skipped', skipped);
    if (!slot) continue;
    // The chip goes beside the name; the slot carries only the role's own text.
    const chipHost = card.querySelector('.role-chip');
    if (chipHost) chipHost.innerHTML = chip ? `<span class="${chip.cls}">${esc(chip.text)}</span>` : '';
    slot.textContent = text;
    // Red ink for a provider failure, cleared when the role works again. A class
    // on the text slot only: the card's border is a different sentence.
    slot.classList.toggle('is-err', Boolean(err));
    slot.title = text;
  }
  if (state.view === 'session') {
    wired.applyRoleCardsLayout({ animate: true, from: fromH, remeasure: true });
  }
  requestAnimationFrame(drawActivePath);
}

/**
 * A permission the running worker asked for, and the harness's answer: one line in
 * that worker's trace, at the moment the answer was given.
 *
 * The Architect's asks arrive as cards in its own chat and their answers sit on its
 * tool cards. A worker's ask has no card of its own and its calls reach the trace as
 * a name and a target, so the answer is recorded where the work is — same place, same
 * second, and the same sentence in the tooltip, a refusal's reason included. Called
 * from the `permission.decided` event, which is the moment that answer exists (10 Nov).
 */
export function noteWorkerPermission(decision) {
  const sessionId = String(decision?.sessionId || '');
  if (!sessionId) return false;
  const run = [...(state.runs?.values?.() || [])].find((r) => r?.workerId === sessionId);
  if (!run) return false;
  const trace = traceOf(run);
  if (!trace) return false;
  const keyOf = (x) => `${Number(x?.at) || 0}:${x?.toolCallId || ''}`;
  if ((trace.notes || []).some((n) => n?.perm && keyOf(n.perm) === keyOf(decision))) return false;
  trace.notes.push({ at: Number(decision.at) || Date.now(), perm: decision });
  if (trace.notes.length > 60) trace.notes.splice(0, trace.notes.length - 60);
  trace.notes.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  renderTranscript();
  return true;
}

/**
 * The same record for a page opened mid-run: a worker's answered permissions are on
 * the server, so its trace asks for them once instead of starting blank.
 */
function seedWorkerPermissions(run) {
  const trace = traceOf(run);
  if (!trace || !run?.workerId) return;
  api('GET', `/api/permissions?session=${encodeURIComponent(run.workerId)}`)
    .then((d) => {
      const rows = (d?.decisions || []).filter((x) => x && x.effect && x.sessionId === run.workerId);
      if (!rows.length) return;
      const keyOf = (x) => `${Number(x?.at) || 0}:${x?.toolCallId || ''}`;
      const have = new Set((trace.notes || []).filter((n) => n?.perm).map((n) => keyOf(n.perm)));
      let added = false;
      for (const row of rows) {
        if (have.has(keyOf(row))) continue;
        trace.notes.push({ at: Number(row.at) || Date.now(), perm: row });
        have.add(keyOf(row));
        added = true;
      }
      if (!added) return;
      trace.notes.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
      renderTranscript();
    })
    .catch(() => {});
}

/** Ask what is running. The SSE stream is the fast path; this is what a page
 *  reloaded in the middle of a run starts from. */
export async function loadRuns() {
  try {
    const { runs } = await api('GET', '/api/runs');
    state.runs = new Map((runs || []).map((r) => [dirKey(r.dir), r]));
    // A lease that is still running when the page opens: seed the clock from the
    // run the server already has, so a reload does not lose it.
    for (const run of runs || []) {
      if (!run.lease || !run.lease.until) continue;
      if (run.lease.kind === 'expired') continue;
      state.leases.set(`${dirKey(run.dir)}|${run.task || ''}`, {
        dir: run.dir || null,
        task: run.task || '',
        role: run.role || '',
        until: Number(run.lease.until) || 0,
        minutes: Number(run.lease.minutes) || 0,
        reason: String(run.lease.reason || ''),
        extended: Boolean(run.lease.extended),
        expired: false,
        at: Date.now(),
      });
    }
    // A page opened mid-run has no trace of its own yet: make one from what the
    // server knows, so the chat shows the worker working straight away rather
    // than waiting for the next progress tick.
    for (const run of runs || []) {
      const key = traceKeyOf(run);
      if (!state.traces.has(key)) {
        state.traces.set(key, {
          key,
          dir: run.dir,
          role: run.role,
          task: run.task,
          title: run.title,
          startedAt: Number(run.startedAt) || Date.now(),
          finishedAt: 0,
          notes: steerNotes(run),
          // The steps it thought before this page opened: the server keeps them so a
          // reload does not lose the trace's reasoning (8 Nov).
          reasons: Array.isArray(run.reasons) ? run.reasons : [],
          stream: null,
          // Runs already compacted before this page was opened. Without it the
          // count starts at nothing and the chat says nothing about a run that is
          // on its fourth compaction — the operator watched exactly that.
          compactions: Number(run.compactions) || 0,
          compactAt: Number(run.compactAt) || 0,
          compactLimit: Number(run.compactLimit) || 0,
          loops: Number(run.loops) || 0,
          loopLimit: Number(run.loopLimit) || 3,
          loopStop: Boolean(run.loopStop),
        });
      }
    }
  } catch { /* the stream will catch up */ }
  state.roleSig = '';
  renderRoleActivity();
}

/**
 * The server is the authority on what is running — ask it, and reconcile.
 *
 * The stream was the only thing that ever *removed* a run, so a page that missed
 * `run.finished` kept it for ever: a dropped connection, a restart, a tab asleep
 * through the event. The chat then said "Working — Stop to take over" over an
 * Architect that had already said it was waiting, and Stop stayed live on a project
 * with nothing running (measured 5 Nov). Nothing corrected it, because the
 * eight-second poll only asked about cards and the engine's own list — and a worker
 * is invisible to both.
 *
 * `askedAt` guards the one race that matters: a run that started after this request
 * left cannot be in its answer, so it is left alone rather than dropped mid-paint.
 */
export async function syncRuns() {
  const askedAt = Date.now();
  let runs;
  try {
    runs = (await api('GET', '/api/runs')).runs || [];
  } catch {
    return;
  }
  const live = runs.map((run) => ({ ...run, key: dirKey(run.dir) }));
  const { drop, add } = reconcileRuns(state.runs, live, askedAt);
  for (const key of drop) {
    const run = state.runs.get(key);
    state.runs.delete(key);
    for (const [leaseKey, lease] of state.leases) {
      if (lease.dir && dirKey(lease.dir) === key) state.leases.delete(leaseKey);
    }
    // Fold its card the way `run.finished` would, without the chime: this is a
    // correction, not work that just ended.
    const trace = run ? traceOf(run) : null;
    if (trace && !trace.finishedAt) {
      trace.finishedAt = Date.now();
      trace.outcome = trace.outcome || 'finished';
    }
  }
  for (const run of add) {
    const { key, ...rest } = run;
    state.runs.set(key, rest);
  }
  if (!drop.length && !add.length) return;
  state.stopping = false;
  renderRoleActivity();
  renderTree();
  renderPlan();
  renderComposer();
}

/**
 * The screen lease, from the server. The stream carries the changes; this is what
 * a page opened mid-lease, or a reconnect, starts from — a lease is not something
 * the page may lose and keep painting the wrong answer.
 */
export async function loadDesk() {
  try {
    const out = await api('GET', '/api/desk');
    state.desk = out?.desk || null;
  } catch {
    state.desk = null;
  }
  wired.renderDesk();
}

/** One delegated run, live: started, its newest tool call, then finished. */
export function handleRunEvent(ev) {
  const key = dirKey(ev.dir);
  // A compaction is news about the run, not a step in it: it lands on the trace as
  // a pinned line, and it is the one note that must survive the four-line tail.
  if (ev.type === 'run.note') {
    const trace = traceFor(ev);
    if (trace && ev.kind === 'compact') noteCompaction(trace, ev);
    if (trace && ev.kind === 'loop') noteLoop(trace, ev);
    if (ev.kind === 'lease') noteLease(ev);
    renderTranscript();
    return;
  }
  // The operator's guidance, on the run's own trace. It is not in the Architect's
  // transcript — it went to the worker's session — so without this line the chat
  // would show nothing at the moment the operator changed the task.
  if (ev.type === 'run.steer') {
    const trace = traceFor(ev);
    if (trace) {
      const said = String(ev.text || '').replace(/\s+/g, ' ').trim();
      const line = said.length > 300 ? `${said.slice(0, 299)}…` : said;
      if (ev.failed) {
        // The line was painted when the operator pressed Steer; the engine then
        // refused it, so the line comes back off and the toast says why.
        const at = trace.notes.findIndex((n) => n?.steer && n.text === line);
        if (at >= 0) trace.notes.splice(at, 1);
        toast('Steer Not Delivered', ev.error || 'The worker never took it.');
      } else {
        // The picture rides the line: the runner saved it in the project, so the
        // chip names the file and the same hover that shows any attachment shows it.
        trace.notes.push({
          at: Date.now(),
          steer: true,
          text: line,
          ...(Array.isArray(ev.files) && ev.files.length ? { files: ev.files } : {}),
        });
        if (trace.notes.length > 60) trace.notes.splice(0, trace.notes.length - 60);
      }
      renderTranscript();
    }
    return;
  }
  // Another view pressed Stop first: the run is finishing its step. The notice
  // and the glow are shared so nobody presses again thinking nothing happened.
  if (ev.type === 'run.stopping') {
    state.stopping = true;
    // A stop is not a finish: no sound for work the operator ended on purpose.
    state.workEndQuiet = true;
    renderComposer();
    return;
  }
  if (ev.type === 'run.started' || ev.type === 'run.progress') {
    // A run reaching a role is that role working again, so its last error is no
    // longer the news. `run.progress` cannot clear it: the runner sends one right
    // after a retry notice, which would erase the notice it just sent.
    if (ev.type === 'run.started' && ev.role) state.roleErrors.delete(`${key}|${ev.role}`);
    if (ev.type === 'run.started') {
      for (const [leaseKey, lease] of state.leases) {
        if (lease.dir && dirKey(lease.dir) === key) state.leases.delete(leaseKey);
      }
    }
    // A new run measures its own speed: the previous one's windows and token
    // totals are not this model's, and carrying them over made the first number
    // on a new card belong to a run that had already finished.
    if (ev.type === 'run.started') resetRate(ev);
    state.runs.set(key, { ...(state.runs.get(key) || {}), ...ev });
    const run = state.runs.get(key);
    const trace = traceOf(run);
    if (!trace && ev.type === 'run.started') {
      state.traces.set(traceKeyOf(run), {
        key: traceKeyOf(run),
        dir: run.dir,
        role: run.role,
        task: run.task,
        title: run.title,
        startedAt: Number(run.startedAt) || Date.now(),
        finishedAt: 0,
        notes: steerNotes(run),
        stream: null,
        loops: 0,
        loopLimit: 3,
        loopStop: false,
      });
      // A run that is already answering asks have their answers on the server; the
      // trace starts with them instead of showing the work without its permissions.
      seedWorkerPermissions(run);
    } else if (trace && run.tool) {
      // One note per new tool call, not one per event: the runner repeats the
      // same call on every progress tick. A call with no target ("reading") is
      // dropped when the note above it already said "reading <file>" — the
      // engine reports the target a moment after the call starts.
      const said = runPhrase(run.tool);
      const last = trace.notes[trace.notes.length - 1];
      const lastText = typeof last === 'string' ? last : String(last?.text || '');
      const generic = !String(run.tool.target || '').trim();
      const repeated = generic && lastText && lastText.split(' ')[0] === said.split(' ')[0];
      // A shell note carries the whole command, quotes and all. One line of the
      // trace is not the place to read it; the card's tooltip and the report are.
      const line = said.length > 300 ? `${said.slice(0, 299)}…` : said;
      const seen = trace.notes.some((n) => (typeof n === 'string' ? n : n?.text) === line);
      if (!repeated && !seen) {
        // The tool object rides the note so the trace can draw the Architect's
        // one-line card; `text` is the floor when the operator turns the cards off
        // (ui.workerCards), and the archive/fold helpers read it either way.
        trace.notes.push({
          at: Date.now(),
          text: line,
          tool: { name: String(run.tool.name || ''), target: String(run.tool.target || '') },
        });
        if (trace.notes.length > 60) trace.notes.splice(0, trace.notes.length - 60);
      }
      // The step is over: whatever it was saying belonged to the step that just
      // ended, and the note is what remains of it. The window it was showing is
      // left in place, dimmed and still — removing it made the chat shrink by
      // eleven lines and grow again at every step, which a fast model does several
      // times a second.
      if (trace.stream) paneEnded(trace);
    }
    // Every progress tick carries the run's own compaction tally, which was read
    // from the transcript by the runner. Taking it here is what makes the count
    // survive a page reload — the `run.note` for a compaction may well have been
    // sent while this page was not listening, and a trace rebuilt from
    // `/api/runs` starts with no notes at all.
    if (trace && Number(run.compactions) > (Number(trace.compactions) || 0)) {
      trace.compactions = Number(run.compactions);
      if (Number(run.compactAt)) trace.compactAt = Number(run.compactAt);
      if (Number(run.compactLimit)) trace.compactLimit = Number(run.compactLimit);
    }
    // The loop count rides the same progress tick, so a page opened after the
    // fact still shows that the run was rescued and how many times.
    if (trace && Number(run.loops) > (Number(trace.loops) || 0)) {
      trace.loops = Number(run.loops);
      if (Number(run.loopLimit)) trace.loopLimit = Number(run.loopLimit);
      trace.loopStop = Boolean(run.loopStop);
    }
  } else if (ev.type === 'run.finished') {
    // A finished, successful run is the role working again; a run that failed is
    // the one case where the red line stays until the next attempt.
    if (ev.role && ev.outcome === 'completed') state.roleErrors.delete(`${key}|${ev.role}`);
    state.stopping = false;
    const done = state.runs.get(key);
    const trace = done ? traceOf(done) : null;
    if (trace) {
      // The last block of thinking has no next block to replace it, so it folds now.
      foldStream(trace);
      // Folded, not deleted: the report is the thing to read, but the evidence of
      // what the worker actually did stays one click away.
      trace.finishedAt = Date.now();
      trace.ms = Number(ev.ms) || 0;
      trace.files = Number(ev.files) || 0;
      trace.outcome = ev.outcome || 'finished';
    }
    state.runs.delete(key);
    for (const [leaseKey, lease] of state.leases) {
      if (lease.dir && dirKey(lease.dir) === key) state.leases.delete(leaseKey);
    }
  } else {
    return;
  }
  renderRoleActivity();
  paintRates();
  // The rail's dot says whether anything is being done for a project, and a run
  // starting or ending is exactly that — the engine's own busy state cannot see
  // a worker, because the Architect's turn is already over by then.
  if (ev.type !== 'run.progress') renderTree();
  // The plan pane overlays the live run too (a running task renders as `doing`
  // whatever the file says), so it needs to know when a run starts and stops — but
  // not on every tool call: that would rebuild the rail for nothing.
  if (ev.type !== 'run.progress') renderPlan();
  else renderTranscript();
  // The composer's Send/Steer face follows the run, not just the engine's busy
  // state: a worker is invisible to the engine's active list while the Architect
  // is idle. `run.started` can arrive before `busyInfo` does.
  renderComposer();
}

// The rail's delegation trunk: one dotted line down the gutter under the
// Architect, with a dash into every role's card, and — while a run is live — the
// yellow arrow with ants on the segment that leads to that role.
//
// Drawn as SVG from the real card boxes, not as CSS borders. Two independent dash
// patterns meeting at a corner leave a notch and a cross that reads as a
// rendering bug: the CSS version had a vertical line whose beads did not line up
// with the horizontal stubs, and the stub stopped a pixel short of the trunk.
// One path, one dash pattern, exact coordinates.
export function drawActivePath() {
  const layer = $('pathLayer');
  const topo = $('topology');
  if (!layer || !topo) return;
  layer.innerHTML = '';
  if (!topo.offsetParent || topo.clientWidth === 0) return; // hidden view

  const arch = topo.querySelector('.topo-architect .role-card');
  // Single mode hides the workers, so there is no trunk to draw: a hidden card
  // has no box, and the layer is empty rather than stale.
  const cards = [...topo.querySelectorAll(':scope > .role-card')].filter((c) => c.offsetParent);
  if (!arch || !arch.offsetParent || !cards.length) return;

  const box = topo.getBoundingClientRect();
  const n = (v) => Math.round(v * 1000) / 1000;
  const a = arch.getBoundingClientRect();
  const first = cards[0].getBoundingClientRect();

  // The gutter is the space between the rail's edge and the cards; the trunk runs
  // down its centre. The Architect spans the gutter (its left edge is the rail's),
  // the workers start after it, which is why the trunk's x is measured from the
  // first worker card rather than from the top.
  const x = n((first.left - box.left) / 2);
  const y0 = n(a.bottom - box.top);
  const mid = (r) => n(r.top + r.height / 2 - box.top);
  const edge = (r) => n(r.left - box.left);

  layer.setAttribute('viewBox', `0 0 ${n(box.width)} ${n(box.height)}`);
  layer.setAttribute('preserveAspectRatio', 'none');

  // A hairline, not dots. Two attempts at dashes failed for the same reason: a
  // dotted line is a hundred small judgements about where a bead starts, and the
  // layer does not begin on a whole pixel. A solid 1px line has no beads to place
  // and antialiases evenly along its whole length.
  const yLast = mid(cards[cards.length - 1].getBoundingClientRect());
  const lines = cards
    .map((card) => {
      const r = card.getBoundingClientRect();
      const m = mid(r);
      return `M ${x} ${m} L ${edge(r)} ${m}`;
    })
    .join(' ');
  let markup =
    `<g class="trunk" shape-rendering="crispEdges">` +
    `<path d="M ${x} ${y0} L ${x} ${yLast}"></path>` +
    `<path d="${lines}"></path>` +
    `</g>`;

  const run = currentRun();
  const dest = run ? cardFor(run.role) : null;
  if (run && dest && dest.offsetParent) {
    const d = dest.getBoundingClientRect();
    const y1 = mid(d);
    const x1 = edge(d);
    // The same L the trunk already draws to that card, in the live colour: down
    // from the Architect, then across into the worker's edge.
    const path = `M ${x} ${y0} L ${x} ${y1} L ${x1} ${y1}`;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Even pitch rather than a fixed count: a long path gets more ants, so the
    // beads read as one dotted line the whole way, and the speed stays constant
    // instead of the ants sprinting down a short path and crawling down a long one.
    const len = Math.abs(y1 - y0) + Math.abs(x1 - x);
    const COUNT = Math.max(5, Math.round(len / 16));
    // Twice the original speed (operator's call, 9 Nov): fast enough to read as
    // moving, slow enough to follow. The `begin` offsets are fractions of DUR, so
    // the pitch still scales with it and a longer path keeps the same apparent
    // speed.
    const DUR = Math.max(2.2, len / 90);
    const ants = reduce
      ? ''
      : Array.from({ length: COUNT }, (_, i) =>
          `<circle r="2.8"><animateMotion dur="${DUR.toFixed(2)}s" begin="${(i * DUR / COUNT).toFixed(2)}s" repeatCount="indefinite" path="${path}"></animateMotion></circle>`,
        ).join('');

    // No arrowhead: the moving beads already say which way the work is flowing,
    // and a second mark at the card's edge read as clutter against the border.
    markup += `<path class="flow" d="${path}"></path>` + ants;
  }

  layer.innerHTML = markup;
}
