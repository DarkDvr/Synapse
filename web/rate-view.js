// The number in the role card's corner: how fast the model is writing, and how
// much of its window the last prompt filled.
//
// Both come from the stream itself, never from the engine's timestamps — the
// measurement and the reasons are in the block below, which is why it is one file:
// the maths, the memory of the current step and the paint of the card all describe
// one number.
import { state } from './state.js';
import { addSample, rateOf } from './rate.js';

// Five things this file needs from app.js: the folder key, the run on screen, the
// model behind a ref, the role's selection, and the token formatter. Wired at boot.
const wired = {
  dirKey: (dir) => String(dir || '').toLowerCase(),
  currentRun: () => null,
  modelByRef: () => null,
  selectionFor: () => ({ ref: '' }),
  fmtTokens: (n) => String(n),
};

/** Hand this module the five things that live in app.js. Called once, at boot. */
export function rateViewWiring(fns) {
  Object.assign(wired, fns);
}

// Tokens per second, from the stream itself.
//
// The only interval that excludes everything that is not writing is the one
// between the first piece of a step and its last. The engine's own timestamps do
// not give that: `time.created` is stamped before the engine assembles the
// request, so a turn the model server clocked at 72.8 tok/s reads 28 here once
// the transcript is 97k tokens, and the error grows as the run does. Measured
// 27 Oct against the provider's own log.
//
// One step is still a noisy sample — a small tool-call step is mostly overhead —
// so the card shows the run's average: every measured step's written tokens over
// the sum of those steps' streaming windows. It settles within a few steps and
// then barely moves, which is what a rate on a card is for.
const deltaWindow = new Map(); // sessionId -> { first, last }
const usageTotals = new Map(); // dirKey -> tokens written so far in this run
const RATE_FRESH_MS = 45000;

export function noteDelta(ev) {
  if (!ev.sessionId) return;
  const w = deltaWindow.get(ev.sessionId) || { first: 0, last: 0 };
  const now = Date.now();
  if (!w.first) w.first = now;
  w.last = now;
  deltaWindow.set(ev.sessionId, w);
}

/** A finished run's rate is history: the next run starts its own. */
export function resetRate(run) {
  if (!run) return;
  const key = wired.dirKey(run.dir);
  state.rates.delete(key);
  usageTotals.delete(key);
}

/**
 * The open session's own last prompt, for the Architect's card.
 *
 * A worker's usage arrives for the worker's session and is read by the runner; the
 * Architect's own never went anywhere, so its card could say how long it had been
 * working and nothing about what it was carrying. The event is the same one, on
 * the same stream, so this is a copy and not a measurement of its own.
 */
export function noteArchitectUsage(ev) {
  const tokens = ev.raw?.data?.tokens;
  if (!tokens) return;
  state.archCtx = {
    sessionId: ev.sessionId,
    used: (Number(tokens.input) || 0) + (Number(tokens.cache?.read) || 0),
    at: Date.now(),
  };
  paintRates();
}

/** The same number, from the transcript: the open session's newest prompt. */
export function lastPromptOf(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.type === 'assistant' && m.raw?.tokens);
  const t = last?.raw?.tokens;
  if (!t) return null;
  return {
    sessionId: state.sessionId,
    used: (Number(t.input) || 0) + (Number(t.cache?.read) || 0),
    at: Date.now(),
  };
}

export function noteWorkerUsage(ev) {
  const run = wired.currentRun();
  if (!run || !ev.sessionId || ev.sessionId !== run.workerId) return;
  const tokens = ev.raw?.data?.tokens;
  if (!tokens) return;
  const total = (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
  const key = wired.dirKey(run.dir);
  // The window belongs to the step this usage figure is about, so it is taken
  // whatever the outcome: a step that wrote nothing must not leave its timings
  // behind to be paired with the next step's tokens.
  const w = deltaWindow.get(ev.sessionId);
  deltaWindow.delete(ev.sessionId);
  const prev = usageTotals.get(key);
  usageTotals.set(key, total);
  // The first step of a run has no earlier total to subtract, and a page opened
  // mid-run starts here; the next step is the first one it can measure.
  if (prev === undefined || total <= prev) return;
  const written = total - prev;
  const ms = w ? w.last - w.first : 0;
  if (!ms || ms < 400) return;
  const rec = state.rates.get(key) || { role: run.role, tokens: 0, ms: 0, at: 0 };
  const tally = addSample({ tokens: rec.tokens, ms: rec.ms }, { written, ms });
  rec.role = run.role;
  rec.tokens = tally.tokens;
  rec.ms = tally.ms;
  rec.at = Date.now();
  state.rates.set(key, rec);
  paintRates();
}

export function paintRates(now = Date.now()) {
  const run = wired.currentRun();
  const rate = run ? state.rates.get(wired.dirKey(run.dir)) : null;
  // The Architect is not a delegated run, so no `runs` record describes it. Its
  // window comes from the usage event its own session sends, and the window size
  // from the model on its card — the same pair, in the same corner.
  const arch = state.archCtx?.sessionId === state.sessionId ? state.archCtx : null;
  const archLimit = arch ? Number(wired.modelByRef(wired.selectionFor('architect').ref)?.context) || 0 : 0;
  for (const card of document.querySelectorAll('#topology .role-card')) {
    const el = card.querySelector('.role-rate');
    if (!el) continue;
    const mine = run && rate && rate.role === card.dataset.role && now - rate.at < RATE_FRESH_MS;
    const bits = [];
    // The run's own measured average. Shown only while it has something behind it:
    // a step or two of evidence is a number, one short step is a guess.
    const tps = mine ? rateOf(rate) : 0;
    if (tps) bits.push(`${tps} tok/s`);
    // The window, in the corner the operator already looks at: "27k/60k ctx". It
    // is the pair that explains a slowdown (a full window is re-read every turn)
    // and the compaction that follows. Shown even when the rate has gone stale —
    // the fill of the window is true whether or not the model is writing.
    let tip = '';
    if (card.dataset.role === 'architect' && Number(arch?.used) > 0) {
      bits.push(`${wired.fmtTokens(arch.used)}${archLimit ? `/${wired.fmtTokens(archLimit)}` : ''} ctx`);
      tip = `The Architect's last prompt: ${arch.used} tokens` + (archLimit ? ` of ${archLimit}` : '');
    } else if (run && run.role === card.dataset.role && Number(run.ctx) > 0) {
      bits.push(`${wired.fmtTokens(run.ctx)}${run.ctxLimit ? `/${wired.fmtTokens(run.ctxLimit)}` : ''} ctx`);
      tip =
        `Prompt ${run.ctx} tokens of ${run.ctxLimit || 'an unknown window'}` +
        (run.ctxRoom ? `; Synapse compacts near ${run.ctxRoom}` : '');
    }
    const text = bits.join(' · ');
    if (el.textContent !== text) el.textContent = text;
    if (el.title !== tip) el.title = tip;
  }
}
