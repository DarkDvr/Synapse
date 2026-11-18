// Run one chat scenario through the new renderer in a real browser.
//
// The structural cases run in Node (tests/scenario-player.mjs); this is for the ones that
// need geometry and time — the anchor under load, a burst, a tall form, a resize. It stages
// the page modules and the scenarios beside a lab page, serves that folder through
// skills/visual-review, and prints what each frame measured.
//
//   bin\node\node.exe scripts\chat-lab.mjs S1-folds            frames
//   bin\node\node.exe scripts\chat-lab.mjs S1-folds --shot     a picture, with the audit
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
const width = flag('width', '1400');
const height = flag('height', '900');

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
const common = [runner, path.join(stage, 'lab.html'), '--widths', width, '--height', height];

const run = shot
  ? // A picture needs the scenario played before the capture, and a beat for layout.
    ['--do', `wait:400; eval:window.__labRun(${JSON.stringify(scenario)}); wait:900`, '--out', path.join(stage, 'shots'), '--audit']
  : ['--do', 'wait:400', '--eval', `(async () => await window.__labRun(${JSON.stringify(scenario)}))()`];

const out = spawnSync(process.execPath, [...common, ...run], { stdio: 'inherit' });
if (out.status !== 0) process.exit(out.status || 1);
