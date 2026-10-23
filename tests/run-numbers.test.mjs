// The numbers the run line and the role card show, from a real transcript.
//
// Two claims earned on 23 Oct, both about telling the truth with numbers:
//  - a provider that folds thinking into `output` reported `reasoning: 0`, so the
//    run line said "0% thinking" while 43k characters of thinking sat in the
//    transcript;
//  - the card's speed, divided by the whole step, read ~60 tok/s where the same
//    turn's own clock said 110.
import { contextStats, writingSpeed, thinkNote } from '../src/runs.js';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const turn = ({ out = 100, reasoning = 0, created = 1000, streamed = null, completed = null, reasoningText = '' }) => ({
  type: 'assistant',
  parts: reasoningText ? [{ type: 'reasoning', text: reasoningText }] : [],
  raw: {
    tokens: { input: 10, output: out, reasoning, cache: { read: 90, write: 0 } },
    time: { created, streamed, completed },
  },
});

// ── the thinking share when the provider splits it ───────────────
{
  const c = contextStats([turn({ out: 100, reasoning: 300 })]);
  check('a provider that splits thinking gets a real share', c.thinkShare === 75, `${c.thinkShare}`);
  check('and is not called unsplit', c.thinkUnsplit === false, String(c.thinkUnsplit));
  check('the run line says it', thinkNote(c) === '75% thinking', thinkNote(c));
}

// ── the thinking share when it does not ──────────────────────────
{
  const c = contextStats([turn({ out: 14875, reasoning: 0, reasoningText: 'x'.repeat(43526) })]);
  check('thinking inside the answer is not reported as zero', c.thinkUnsplit === true, JSON.stringify(c));
  check('and the words say so', thinkNote(c).includes('thinking included'), thinkNote(c));
  check('the written total still counts it', c.generated === 14875, String(c.generated));
}

// A model that thought nothing at all is honestly 0%.
{
  const c = contextStats([turn({ out: 50 })]);
  check('a turn with no reasoning text is a real 0%', c.thinkUnsplit === false && c.thinkShare === 0, JSON.stringify(c));
}

// ── the writing speed, from the turn's own clock ─────────────────
{
  // 882 tokens in 7.892 s is 112 tok/s — the number the model's own server printed.
  const speed = writingSpeed([turn({ out: 882, created: 1000, streamed: 8892 })]);
  check('speed is the writing window, not the whole step', speed === 112, String(speed));
}

{
  // No streamed stamp: the finished time is the next best thing.
  const speed = writingSpeed([turn({ out: 1000, created: 2000, streamed: null, completed: 12_000 })]);
  check('a missing streamed stamp falls back to completion', speed === 100, String(speed));
}

{
  const speed = writingSpeed([turn({ out: 0, created: 1000, streamed: 8892 })]);
  check('a turn that wrote nothing has no speed', speed === 0, String(speed));
}

{
  const speed = writingSpeed([
    turn({ out: 500, created: 1000, streamed: 6000 }),
    turn({ out: 2000, created: 20_000, streamed: 30_000 }),
  ]);
  check('the last turn is the one measured', speed === 200, String(speed));
}

{
  check('a transcript with no assistant turn has no speed', writingSpeed([]) === 0);
  check('and neither does one with no timings', writingSpeed([turn({ out: 10, created: 0 })]) === 0);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
