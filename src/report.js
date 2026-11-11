// The report the Architect reads when a run ends.
//
// It was the first of four jobs living in runs.js, and the only one with no runner
// state in it: a run's facts go in, the sentence the Architect reads comes out. That
// makes it the clean seam - the worker loop, the wake loop and the ledger stay where
// they are.
//
// The rule it encodes: the head says what happened (finished, stopped by the
// operator, stopped by the harness, timed out), the body says what the worker
// claimed, and the last line says what the Architect should do next. A stop is not
// a failure and must not read like one.
//
// Everything this file uses has to be imported: it was carved out of runs.js, and a
// name left behind there is not a syntax error, it is a ReferenceError five seconds
// after a worker finishes - the Architect never told, the plan stuck on `doing`, the
// screen saying nothing (found by the smoke test, 7 Nov). tests/report.test.mjs
// walks every branch so the next move cannot repeat it.

import { QC_ROUNDS } from './plans.js';
import { tokens } from './words.js';

export function report({ task, role, insteadOf, startedBelow = false, skipped, outcome, harnessStop, text, files, context, workerId, planTouched, synapseTouched, qcRound, skillsRequired, skillsMissing, auto, stallSec, retries, resumes, loops = 0, loopCount = 0, loopMarked = false, loopRole = null, loopModel = null, modelRef = '', error, stoppedBy, lastTurnError, steers, deferred }) {
    const head =
      outcome === 'completed'
        ? `${task.id} (${role}) finished.`
        : outcome === 'timeout'
          ? `${task.id} (${role}) produced nothing for ${Math.round(stallSec / 60)} minutes in a row and was stopped` +
            `${resumes ? ` after ${resumes} restart${resumes === 1 ? '' : 's'}` : ''}.`
          : harnessStop
            ? `${task.id} (${role}) was stopped by the harness, not by the operator.`
            : stoppedBy === 'operator'
              ? `${task.id} (${role}) was stopped by the operator. ` +
                `A stop is not a verdict on the task or the model.`
              : outcome === 'error'
                ? loopMarked && (!loopRole || loopRole === role)
                  ? `${task.id} (${role}) was stopped: it looped ${loopCount || loops} time` +
                    `${(loopCount || loops) === 1 ? '' : 's'} in one work order.`
                  : `${task.id} (${role}) could not run - the provider refused the turn, so no further work was attempted.`
                : `${task.id} (${role}) could not run.`;
    const lines = [head];
    if (insteadOf) {
      const why = startedBelow ? null : (skipped || []).find((s) => s.role === insteadOf);
      lines.push(
        `This attempt ran on ${role}, not ${insteadOf}: ${insteadOf} could not do it, so the harness moved the ` +
          `task down its line of coders. The plan still says ${insteadOf} - leave the role as it is and judge ` +
          `the work on its merits.` +
          (why?.message
            ? `\n${insteadOf} did not finish: ${why.message}`
            : startedBelow
              ? `\n${insteadOf}'s model is marked ISSUES, so this task started further down the line.`
              : ''),
      );
    }
    // The operator may have changed the task while it ran. The Architect must
    // judge the work against what was actually asked for at the end, not the
    // brief the worker started with.
    if (steers?.length) {
      lines.push('The operator steered this run while it worked:');
      for (const s of steers.slice(-3)) {
        const said = String(s.text || '').replace(/\s+/g, ' ').trim();
        lines.push(`- ${s.by ? `${s.by}: ` : ''}"${said}"`);
      }
      lines.push(
        'Judge the work against those instructions, and put the change in the task note and the plan so the ' +
          'plan matches the work. If a steer changes the task materially, ask the operator with the question ' +
          'tool before locking it in.',
      );
    }
    // A stop is the operator's decision, not a coder's failure. Without this the
    // Architect's first move was to delegate the same task again; the project is
    // held, so that delegation is refused - better not to ask.
    if (stoppedBy === 'operator') {
      lines.push('The operator stopped it on purpose: do not delegate this task again unless they say so.');
    }
    // Asks that arrived while this ran were answered "another task is already
    // running" and nothing was started for them. The report is where the Architect
    // hears it, once, when it is free to act — a wake per ask bought a turn per ask
    // while the worker was still working (5 Nov).
    if (deferred?.length) {
      const counts = new Map();
      for (const d of deferred) counts.set(d.task, (counts.get(d.task) || 0) + 1);
      const said = [...counts].map(([id, n]) => (n > 1 ? `${id} ${n} times` : id)).join(', ');
      lines.push(
        `While this ran, the harness also received a delegation for ${said} and deferred it: another task was ` +
          `already running, so nothing was started for it. Judge this report first; then delegate it if it is ` +
          `still to do.`,
      );
    }
    if (loops) {
      lines.push(
        `${loopRole && loopRole !== role ? `${loopRole}'s work` : 'Its work'} was caught going in circles ` +
          `${loops} time${loops === 1 ? '' : 's'}; the harness interrupted it and asked for the next real step.`,
      );
    }
    // The mark is a fact about one coder, and the task may already have moved on.
    // Naming the run's *final* role here told the Architect that the coder which
    // had just delivered the work was the broken one, and the next task stalled
    // while it waited for an operator nobody had woken.
    if (loopMarked) {
      const markedRole = loopRole || role;
      const markedModel = loopModel || modelRef;
      lines.push(
        `The model ${markedModel || `behind ${markedRole}`} is marked with the ISSUES badge: it looped ` +
          `${loopCount || loops} time${(loopCount || loops) === 1 ? '' : 's'} in one work order.` +
          (markedRole === role
            ? ` Do not delegate to ${markedRole} again until the operator fixes the model or the role, and tell the ` +
              `operator this role is out of action.`
            : ` This task ran on ${role} instead, and Synapse will start this project's build tasks one rung lower ` +
              `from now on - on ${role} until the operator fixes ${markedRole} or its model. Tell the operator ` +
              `${markedRole} is out of action, and judge ${role}'s work on its merits.`),
      );
    }
    // The evidence, never omitted: a worker that claims a file it did not write
    // is a real failure mode (it happened on the first run: the report named
    // bin/calendar_design.md and no such file existed). "Files written: none"
    // is what made the claim obvious to the Architect.
    if (lastTurnError && !/step interrupted/i.test(lastTurnError)) {
      lines.push(`Before the stop, the last turn had ended with: ${lastTurnError}`);
    }
    lines.push(files.length ? `Files written: ${files.join(', ')}` : `Files written: none.`);
    if (skillsMissing?.length) {
      lines.push(
        `Skills this role is required to load, and did not: ${skillsMissing.join(', ')}. The brief asks for ` +
          `them before the first edit; judge whether the work is complete without them.`,
      );
    }
    // reached 200k generated at half the rate of one that stayed under 50k, so a
    // long run is mostly a big transcript — which is the signal to split it, not
    // to doubt the model.
    // The time and the token spend are in the chat's header (see the wake's
    // description), so they are not repeated here. What is left is the shape of
    // the effort: how many turns, how big the context got, whether it was
    // summarised. A long run that stayed under 50k generated is a big transcript,
    // which is the signal to split it, not to doubt the model.
    if (context && context.turns) {
      lines.push(
        `Effort: ${context.turns} turn${context.turns === 1 ? '' : 's'}; the context peaked at ` +
          `${tokens(context.peak)}` +
          (context.compactions
            ? context.compactions === 1
              ? ' and was summarised once.'
              : ` and was summarised ${context.compactions} times.`
            : '.') +
          (context.peak > 150000 ? ' Past about 150k a run gets slower with every turn.' : ''),
      );
    }
    // How much of the night went into this. A recovered run is not a bad run, and
    // the Architect should not read five retries as five failures.
    if (retries) {
      lines.push(
        `The provider failed ${retries} time${retries === 1 ? '' : 's'} on the way (rate limits and connection ` +
          `errors are retried, not counted as attempts); the work above is what survived.`,
      );
    }
    if (resumes) {
      lines.push(
        `It was restarted ${resumes} time${resumes === 1 ? '' : 's'} after producing nothing for a long stretch, ` +
          `and carried on from where it was.`,
      );
    }
    if (error) {
      lines.push(`The provider said: ${error}`);
      lines.push(
        `That is not a judgement on the task. If it names a retired or unknown model, pick another model for ` +
          `that role (or run the task on another role), then delegate this task again.`,
      );
    }
    if (text) lines.push(`Reported:\n${text}`);
    else if (!error) lines.push(`It reported nothing.`);
    if (planTouched) {
      lines.push(
        `Warning: the plan file changed while the worker ran. A worker is never meant to write it — ` +
          `check what changed before trusting the file.`,
      );
    }
    if (Array.isArray(synapseTouched) && synapseTouched.length) {
      lines.push(
        `Warning: these files changed inside .synapse while the worker ran, and they are not this role's to ` +
          `write: ${synapseTouched.slice(0, 8).join(', ')}. The file tools are refused there, so this went ` +
          `around them; check the contents before you trust the plan or the contract.`,
      );
    }
    if (role === 'qc' && qcRound >= QC_ROUNDS) {
      lines.push(
        `That was QC round ${qcRound} of ${QC_ROUNDS} - the loop is closed. Do not delegate another QC pass: ` +
          `tell the operator what is still open, with the issue ids, and let them decide.`,
      );
    }
    // The sentence that hands the judgement back is its own paragraph. Run together
    // with the facts above it read as one stream of text, and this is the line the
    // Architect acts on: a blank line is what the chat's markdown turns into a break,
    // and it separates "what happened" from "what to do about it" (11 Nov).
    lines.push('');
    lines.push(
      `You are the only writer of the plan: judge this yourself. Mark ${task.id} done if it holds, ` +
        `send it back with what is wrong if it does not, or mark it blocked if it needs the operator.`,
    );
    lines.push(
      auto
        ? `Keep building is ON: having judged this, delegate the next task whose dependencies are done ` +
            `and keep going until the plan is finished or a task is blocked.`
        : `Keep building is OFF: stop after judging this one and wait for the operator.`,
    );
    return lines.join('\n');
  }
