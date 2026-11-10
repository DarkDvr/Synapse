// The Architect's post opens on its first token, and the bar that shows the work
// says so in Single mode too.
//
// Both are page behaviour, and a page that is not running cannot be asked to prove
// either without a live model turn. So what is asserted here is the wiring that was
// missing, in the files that carry it: the engine's message is written on the
// engine's schedule, and the page has to open the post itself and then let the real
// one replace it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
const fails = [];
const check = (label, ok, detail = '') => {
  if (ok) pass += 1;
  else fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};

const app = read('web/app.js');
const live = read('web/live-runs.js');
const transcript = read('web/transcript.js');

// ── the post is the page's, opened on the first delta ─────────────
check('the page can open a post of its own', /function ensureLivePost\(\)/.test(app));
check(
  'it opens on a thinking delta',
  /EV\.reasoningDelta\)\s*\{\s*ensureLivePost\(\);/.test(app),
  'reasoning branch does not call it',
);
check('it opens on a speech delta', /EV\.textDelta\)\s*\{\s*ensureLivePost\(\);/.test(app), 'text branch does not call it');
check(
  'it does not open a second one when the turn already has its post',
  /last\.type === 'assistant' && !last\.completed\) return false/.test(app),
);
check(
  'the placeholder is kept until the transcript ends with the engine\'s own message',
  /tail && tail\.type === 'assistant'/.test(app) && /startsWith\('local-live-'\)/.test(app),
);
check('and it goes when the turn ends', /if \(dropLivePost\(\)\) renderTranscript\(\);/.test(app));

// ── the placeholder is a post, not an error ───────────────────────
check(
  'an empty live post does not print a placeholder ellipsis over its thinking',
  /!\(m\.live && tail\)/.test(transcript),
  'the arrow is back on the label',
);

// ── the Architect's card shows the work in Single too ─────────────
check(
  'the bar reads the page\'s own turn state, not only the polled list',
  /isBusy\(state\.sessionId\) \|\| state\.busy/.test(live),
  'archBusy does not include state.busy',
);
check('and the working class is still what the animation hangs on', /classList\.toggle\('is-working', working\)/.test(live));
check('the single-mode bar is the same card, so it gets the same class', /body\[data-mode="single"\] \.topo-architect \.role-card/.test(read('web/panel.css')));

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  ${f}`);
process.exit(fails.length ? 1 : 0);
