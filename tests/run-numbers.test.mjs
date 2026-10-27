// The numbers the run line shows, from a real transcript.
//
// Two claims earned on 23 Oct, both about telling the truth with numbers:
//  - a provider that folds thinking into `output` reported `reasoning: 0`, so the
//    run line said "0% thinking" while 43k characters of thinking sat in the
//    transcript;
//  - the run line's context figures are the prompt's, not the answer's.
//
// Tokens per second used to be measured here, from a turn's `created` and
// `streamed` stamps. It was removed on 27 Oct: those stamps include the engine
// assembling the request, so a turn the model server clocked at 72.8 tok/s read
// 28 once the transcript was 97k tokens. The measurement moved to the stream's
// own first and last piece, in `web/app.js`.
import { contextStats, thinkNote, outsideProject } from '../src/runs.js';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const turn = ({ out = 100, reasoning = 0, created = 1000, streamed = null, completed = null, reasoningText = '', retry = null }) => ({
  type: 'assistant',
  parts: reasoningText ? [{ type: 'reasoning', text: reasoningText }] : [],
  raw: {
    tokens: { input: 10, output: out, reasoning, cache: { read: 90, write: 0 } },
    time: { created, streamed, completed },
    ...(retry ? { retry } : {}),
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

// ── a write outside the project ─────────────────────────────────
{
  // Measured 23 Oct: a coder wrote a scratch script to %TEMP% through `shell`,
  // where no path rule reaches, and nothing anywhere said so.
  const dir = 'F:\\dev\\Synapse.Projects\\tide';
  check('a relative path is inside the project', outsideProject('bin/index.html', dir) === false);
  check('a file under the project is inside it', outsideProject('F:\\dev\\Synapse.Projects\\tide\\bin\\index.html', dir) === false);
  check('the same folder in forward slashes is inside', outsideProject('F:/dev/Synapse.Projects/tide/bin/index.html', dir) === false);
  check('a sibling project is outside', outsideProject('F:\\dev\\Synapse.Projects\\other\\x.txt', dir) === true);
  check('a temp file is outside', outsideProject('C:\\Users\\Andrew\\AppData\\Local\\Temp\\opencode\\kbd.ps1', dir) === true);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
