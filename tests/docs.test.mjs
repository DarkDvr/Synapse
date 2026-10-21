// The size budget for the documentation, because "keep it short" is a promise
// and a promise is not a mechanism.
//
// AGENTS.md is loaded into every maintenance turn: it is the one file whose
// length costs something before any work starts. It was 1,707 lines / ~34k
// tokens before the split, which is why this exists. The notes in docs/notes/
// are read on purpose and are not budgeted.
//
// Run: node tests\docs.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const lines = (rel) => read(rel).replace(/^\uFEFF/, '').split(/\r?\n/).length;
// Roughly 3.6 characters per token on prose this dense. An estimate is enough:
// the budget is a ceiling, not an accounting exercise.
const tokens = (rel) => Math.round(read(rel).length / 3.6);

const BUDGET = { 'AGENTS.md': 300, 'README.md': 180 };

let pass = 0;
let fail = 0;
const check = (ok, label, detail = '') => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  <- ${detail}` : ''}`);
};

// ── the budgets ─────────────────────────────────────────────────
for (const [file, max] of Object.entries(BUDGET)) {
  const n = lines(file);
  check(n <= max, `${file} within ${max} lines`, `${n} lines, ~${tokens(file)} tokens`);
}

// ── the index is real ───────────────────────────────────────────
// Every notes file must exist, and AGENTS.md must point at it: a file an agent
// does not know to open is a file that does not exist.
const NOTES = [
  'docs/notes/engine-notes.md',
  'docs/notes/models-and-tools.md',
  'docs/notes/runtime-scope.md',
  'docs/notes/ui-lessons.md',
  'docs/notes/runbook.md',
];
const agents = read('AGENTS.md');
const slashed = (rel) => [rel, rel.replace(/\//g, '\\')];
for (const rel of NOTES) {
  check(fs.existsSync(path.join(ROOT, rel)), `${rel} exists`);
  check(slashed(rel).some((form) => agents.includes(form)), `AGENTS.md links ${rel}`);
}

// Nothing may be orphaned: a notes file that AGENTS.md does not name is a file
// nobody will read.
const onDisk = fs.existsSync(path.join(ROOT, 'docs/notes'))
  ? fs.readdirSync(path.join(ROOT, 'docs/notes')).filter((f) => f.endsWith('.md'))
  : [];
check(
  onDisk.every((f) => NOTES.some((n) => n.endsWith(`/${f}`))),
  'every file in docs/notes/ is linked from AGENTS.md',
  onDisk.join(' '),
);

// ── the rules that must never be dropped ────────────────────────
// A compression pass is exactly how one of these disappears. They are the lines
// that cost days when they are wrong, so they are asserted, not assumed.
const MUST_KEEP = [
  ['AGENTS.md', 'Never match processes by name', 'the desktop-app kill rule'],
  ['AGENTS.md', '@opencodedesktop', 'the denylist'],
  ['AGENTS.md', 'Zero npm dependencies', 'hard rule 1'],
  ['AGENTS.md', 'Self-contained and offline', 'hard rule 2'],
  ['AGENTS.md', 'Engine-agnostic core', 'hard rule 4'],
  ['AGENTS.md', 'All button labels are Title Case', 'the label rule'],
  ['AGENTS.md', '8700', 'the UI port'],
  ['AGENTS.md', 'restart.ps1', 'the restart script'],
  ['AGENTS.md', 'docs/notes/', 'the index'],
  ['AGENTS.md', 'LocationNotFoundError', 'a session needs a real directory'],
  ['docs/notes/engine-notes.md', 'last matching rule wins', 'permission rule ordering'],
  ['docs/notes/engine-notes.md', 'Never put a lone backslash', 'the brief escaping rule'],
  ['docs/notes/ui-lessons.md', 'overflow: clip', 'the card wrapper must never scroll'],
  ['docs/notes/ui-lessons.md', 'scrollbar-gutter', 'scroll stability'],
];
for (const [file, needle, why] of MUST_KEEP) {
  check(read(file).includes(needle), `${file} keeps ${why}`, needle);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
