// Run one chat scenario through the new renderer in a real browser.
//
// The structural cases run in Node (tests/scenario-player.mjs); this is for the ones that
// need geometry and time — the anchor under load, a burst, a tall form, a resize. It stages
// the page modules and the scenarios beside a lab page, serves that folder through
// skills/visual-review, and prints what each frame measured.
//
//   bin\node\node.exe scripts\chat-lab.mjs S1-folds            frames
//   bin\node\node.exe scripts\chat-lab.mjs S1-folds --shot     a picture, with the audit
//   bin\node\node.exe scripts\chat-lab.mjs --check             the promises, as pass/fail
//   bin\node\node.exe scripts\chat-lab.mjs S1-folds --width 900 --height 700
//
// The staging folder is rebuilt every run, and lives outside the repository: nothing is
// served that is not the page, the scenarios and the lab.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith('-')) || 'S1-folds';
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const shot = args.includes('--shot');
const check = args.includes('--check');
const width = flag('width', '1400');
const height = flag('height', '900');
// Which panel a scenario's `select` step picks in. The promise is a comparison, so the same
// scenario is played twice: once against each renderer's panel.
const panel = flag('panel', '');

const stage = path.join(tmpdir(), 'synapse-chat-lab');
rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'tests', 'scenarios'), { recursive: true });
copy('web', 'web');
copy('tests/scenario-steps.mjs', 'tests/scenario-steps.mjs');
copy('tests/scenarios', 'tests/scenarios');
copy('tests/browser/lab.html', 'lab.html');
copy('tests/browser/lab.js', 'lab.js');

function copy(from, to) {
  cpSync(path.join(ROOT, from), path.join(stage, to), { recursive: true });
}

const runner = path.join(ROOT, 'skills', 'visual-review', 'bin', 'shot.mjs');
// A page's motion is part of what it looks like; the headless browser turns it off unless
// the review asks for it. `--motion` is passed through to the shot script.
const common = [runner, path.join(stage, 'lab.html'), '--widths', width, '--height', height, ...(args.includes('--motion') ? ['--motion'] : [])];

// The promises, as cases that fail: the lab page answers a report, this prints it and
// leaves a non-zero exit code when one broke. Run it with `--check` and nothing to name.
if (check) {
  const run = spawnSync(
    process.execPath,
    [...common, '--do', 'wait:400', '--eval', '(async () => await window.__labCheck())()'],
    { encoding: 'utf8', maxBuffer: 1 << 24 },
  );
  const line = String(run.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let answer = null;
  try {
    answer = JSON.parse(line);
  } catch {
    // No report at all: the page did not load, or the check threw before it could answer.
  }
  if (!answer) {
    process.stderr.write(`lab: no answer from the page\n${run.stdout || ''}${run.stderr || ''}`);
    process.exit(1);
  }
  if (answer.error) {
    process.stderr.write(`lab: the page threw — ${answer.error}\n`);
    process.exit(1);
  }
  const report = answer.value || {};
  const cases = report.cases || [];
  for (const c of cases) process.stdout.write(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}\n`);
  if (!cases.length) {
    process.stderr.write('lab: the page answered no cases\n');
    process.exit(1);
  }
  if (!report.pass) process.exit(1);
  process.stdout.write(`lab: ${cases.length} case(s) held\n`);
  process.exit(0);
}

const run = shot
  ? // A picture needs the scenario played before the capture, and a beat for layout.
    ['--do', `wait:400; eval:window.__labRun(${JSON.stringify(scenario)}); wait:900`, '--out', path.join(stage, 'shots'), '--audit']
  : ['--do', 'wait:400', '--eval', `(async () => await window.__labRun(${JSON.stringify(scenario)}, 0, ${JSON.stringify(panel)}))()`];

const out = spawnSync(process.execPath, [...common, ...run], { stdio: 'inherit' });
if (out.status !== 0) process.exit(out.status || 1);
