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
 * Forget the per-step baseline and the open window, keeping the tally already shown.
 *
 * The stream dropped, so the `usage.updated` events that keep the baseline current were
 * lost with it. The next one would subtract a total from several steps ago: two steps'
 * tokens divided by one step's streaming time, which reads as double the speed — and as
 * 1000+ tok/s when the gap was longer (13 Nov). After this, the next event is a new
 * baseline and no sample is taken from the gap.
 */
export function forgetUsageSamples() {
  usageTotals.clear();
  deltaWindow.clear();
}

/**
 * The open session's own last prompt, for the Architect's card.
 *
 * A worker's usage arrives for the worker's session and is read by the runner; the
 * Architect's own never went anywhere, so its card could say how long it had been
 * working and nothing about what it was carrying. The event is the same one, on
 * the same stream, so this is a copy and not a measurement of its own.
 */
/**
 * A context figure cannot be larger than the window it is a fraction of.
 *
 * Some providers report `cache.read` as a running total for the session rather than this
 * step's cached prefix — a 27B on 12 Nov reported five million against a 262K window, which
 * cannot be a prompt: the engine compacts long before that. When the sum exceeds the
 * window, the honest number is the step's fresh `input`, and never more than the window.
 */
export function withinWindow(used, limit) {
  const value = Number(used) || 0;
  const cap = Number(limit) || 0;
  if (!cap) return value;
  return value > cap ? cap : value;
}

/**
 * How much of the prompt came from the provider's cache.
 *
 * The usage fields are `input` (fresh tokens this step) and `cache.read` (the prefix the
 * provider served from its cache), so the prompt is their sum and the share is
 * `read / (input + read)`. A cloud model with prompt caching reports both; a local one
 * reports them when its server does (llama.cpp with cache reuse, LM Studio's KV reuse),
 * and nothing when it does not — in which case there is no share to show, and nothing is
 * invented.
 *
 * It is refused when the sum exceeds the window: that is the signature of a provider
 * reporting `cache.read` as a running session total rather than this step's prefix (a 27B
 * did exactly that on 12 Nov, 5.0M against a 262K window), and a percentage built on it
 * would be fiction.
 */
export function cacheShare(input, cached, limit = 0) {
  const fresh = Math.max(0, Number(input) || 0);
  const read = Math.max(0, Number(cached) || 0);
  const total = fresh + read;
  const cap = Number(limit) || 0;
  if (!total || cap < 0) return { ok: false, pct: 0, fresh, read, total };
  if (cap && total > cap) return { ok: false, pct: 0, fresh, read, total };
  // No cache figure at all: the provider does not report one.
  if (!read) return { ok: false, pct: 0, fresh, read, total };
  return { ok: true, pct: Math.round((read / total) * 1000) / 10, fresh, read, total };
}

/**
 * The Architect's own transcript is being compacted, or has been.
 *
 * The card cannot know the new size the moment the summary lands: the compaction's own
 * usage is the prompt it *summarised* — measured 13 Nov, 167,193 tokens for a context that
 * came out at 10,121 on the next step. Showing that number would be the same lie in a new
 * place, and keeping the old one is worse: the operator watched a card read 205K/205K after
 * the conversation had been cut down. So the card says what is true while it waits —
 * "compacting" then "compacted" — and the next usage event puts the real figure back.
 */
export function noteArchitectCompaction(sessionId, phase) {
  if (!state.sessionId || sessionId !== state.sessionId) return;
  if (phase === 'start') {
    state.archCtx = { ...(state.archCtx || {}), sessionId, used: 0, fresh: 0, cached: 0, pending: 'compacting', at: Date.now() };
  } else if (phase === 'end') {
    state.archCtx = { ...(state.archCtx || {}), sessionId, used: 0, fresh: 0, cached: 0, pending: 'compacted', at: Date.now() };
  }
  paintRates();
}

export function noteArchitectUsage(ev) {
  const tokens = ev.raw?.data?.tokens;
  if (!tokens) return;
  const used = (Number(tokens.input) || 0) + (Number(tokens.cache?.read) || 0);
  // The wiring may not be there (a test process): no wire, no window, and no judgement
  // to make — the number is taken as given.
  let limit = 0;
  try {
    limit = Number(wired.modelByRef(wired.selectionFor('architect').ref)?.context) || 0;
  } catch { /* not wired */ }
  // A prompt cannot be larger than the window it is a prompt for. When the provider
  // reports `cache.read` as a running session total, the sum comes out over the window
  // (262K on a 262K model) while the transcript reports the true 198K — and the two
  // alternate on screen, which reads as a bug because it is one (13 Nov). An implausible
  // event is dropped, not capped: the transcript's own figure is the honest one.
  if (limit && used > limit) return;
  state.archCtx = {
    sessionId: ev.sessionId,
    pending: '',
    used,
    // The two halves, kept so the card can say how much of the prompt the provider's
    // cache served (12 Nov).
    fresh: Number(tokens.input) || 0,
    cached: Number(tokens.cache?.read) || 0,
    at: Date.now(),
  };
  paintRates();
}

/** The same number, from the transcript: the open session's newest prompt. */
export function lastPromptOf(messages) {
  const list = messages || [];
  const last = [...list].reverse().find((m) => m.type === 'assistant' && m.raw?.tokens);
  // A compaction newer than the last step means the context is not the one that step
  // reported. Its own usage is the prompt it summarised (measured 13 Nov: 167,193 for a
  // context that came out at 10,121), so there is no honest number to print — only the
  // fact. The card says "compacted" until the next step reports the real size.
  const pack = [...list].reverse().find((m) => m.type === 'compaction');
  if (pack && (!last || Number(pack.created) > Number(last.created))) {
    const running = String(pack.raw?.status || '') === 'running';
    return { sessionId: state.sessionId, used: 0, fresh: 0, cached: 0, pending: running ? 'compacting' : 'compacted', at: Date.now() };
  }
  const t = last?.raw?.tokens;
  if (!t) return null;
  return {
    sessionId: state.sessionId,
    used: (Number(t.input) || 0) + (Number(t.cache?.read) || 0),
    fresh: Number(t.input) || 0,
    cached: Number(t.cache?.read) || 0,
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
  // No page, no painting: callers in a test process hold the state above, and must not
  // need a DOM to exercise it (13 Nov).
  if (typeof document === 'undefined') return;
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
      const archUsed = withinWindow(arch.used, archLimit);
      const share = cacheShare(arch.fresh, arch.cached, archLimit);
      if (arch.pending) {
        // The number would be a lie: the context was just summarised and the next step
        // has not reported its size yet (13 Nov).
        bits.push(`${arch.pending === 'compacting' ? 'compacting…' : 'compacted'}${archLimit ? ` / ${wired.fmtTokens(archLimit)}` : ''} ctx`);
        tip =
          arch.pending === 'compacting'
            ? 'The engine is summarising this conversation to make room.'
            : 'The conversation was compacted; its new size arrives with the next step.';
      } else {
        // The cache share is in the tooltip, not on the line: at the narrowest card the
        // three readings plus the clock already need every pixel, and "(100% cache)"
        // was the thing the ellipsis ate (13 Nov — measured 173px wanted, 154 available;
        // the line without it is 132px).
        bits.push(`${wired.fmtTokens(archUsed)}${archLimit ? `/${wired.fmtTokens(archLimit)}` : ''} ctx`);
        tip =
          `The Architect's last prompt: ${arch.used} tokens` +
          (archLimit ? ` of ${archLimit}` : '') +
          (share.ok ? ` — ${share.pct}% from the provider's cache (${share.fresh} fresh, ${share.read} read)` : '');
      }
    } else if (run && run.role === card.dataset.role && (Number(run.ctx) > 0 || run.ctxPending)) {
      // A worker's compaction follows the same rule as the Architect's: no size until the
      // next step reports one (13 Nov).
      const runUsed = withinWindow(run.ctx, run.ctxLimit);
      const share = cacheShare(run.ctxFresh, run.ctxCached, run.ctxLimit);
      if (run.ctxPending) {
        bits.push(`${run.ctxPending === 'compacting' ? 'compacting…' : 'compacted'}${run.ctxLimit ? ` / ${wired.fmtTokens(run.ctxLimit)}` : ''} ctx`);
        tip = run.ctxPending === 'compacting'
          ? "The engine is summarising this worker's conversation to make room."
          : "The worker's conversation was compacted; its new size arrives with the next step.";
      } else {
        // Same line, same rule as the Architect's card (13 Nov).
        bits.push(`${wired.fmtTokens(runUsed)}${run.ctxLimit ? `/${wired.fmtTokens(run.ctxLimit)}` : ''} ctx`);
        tip =
          `Prompt ${withinWindow(run.ctx, run.ctxLimit)} tokens of ${run.ctxLimit || 'an unknown window'}` +
          (share.ok ? ` — ${share.pct}% from the provider's cache (${share.fresh} fresh, ${share.read} read)` : '') +
          (run.ctxRoom ? `; Synapse compacts near ${run.ctxRoom}` : '');
      }
    }
    // Two readings on one line, separated by air rather than a dot: "128 tok/s
    // 27k/60k ctx" reads as two values, where a dot between them read as the
    // punctuation of a sentence.
    const text = bits.join('   ');
    if (el.textContent !== text) el.textContent = text;
    if (el.title !== tip) el.title = tip;
  }
}
