// Synapse's own writes are not a worker's tampering, and an alarm says what it is.
//
// Both halves are here because both were wrong in the operator's face on 10 Nov:
// an attached image and an answered question were reported as a worker writing
// outside its folder, and every one of those alarms was titled "A model named
// Synapse in a tool call" whatever it had actually noticed.
import fs from 'node:fs';
import path from 'node:path';
import { markWritten, wroteIt, forgetWrites } from '../src/synapse-writes.js';
import { keepAttachments } from '../src/keep-attachments.js';
import { writeDoc } from '../src/project-doc.js';
import { alarmTitle, renderAlarm } from '../web/chat-notes.js';
import { tmpdir } from './tmpdir.mjs';

let pass = 0;
const fails = [];
// (label, ok, detail) — the label first, because a failing test is read as a
// sentence: "the harness's own copy is excused — false".
const check = (label, ok, detail = '') => {
  if (ok) pass += 1;
  else fails.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`);
};

const ROOT = tmpdir('synapse-writes-');
try {
  const dir = path.join(ROOT, 'project');
  fs.mkdirSync(path.join(dir, '.synapse'), { recursive: true });
  const startedAt = Date.now();

  // ── the module's own promise ──────────────────────────────────
  forgetWrites();
  const one = path.join(dir, '.synapse', 'attachments', 'x.png');
  check('nothing is excused before it is written', wroteIt(one, 0) === false);
  markWritten(one);
  check('a write Synapse made is known', wroteIt(one, startedAt) === true);
  check('and it is not a different file', wroteIt(path.join(dir, '.synapse', 'project.md'), startedAt) === false);
  check('a mark older than the turn excuses nothing', wroteIt(one, Date.now() + 60_000) === false);
  forgetWrites();
  check('forgetting clears it', wroteIt(one, 0) === false);

  // ── a kept attachment says so ─────────────────────────────────
  const kept = keepAttachments(dir, [
    { name: 'image.png', mime: 'image/png', keep: true, data: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64') },
    { name: 'skipped.png', mime: 'image/png', keep: false, data: 'AAAA' },
  ]);
  check('the kept attachment is written', kept.length === 1, JSON.stringify(kept));
  const keptFull = path.join(dir, ...String(kept[0]?.path || '').split('/'));
  check('the file is there', fs.existsSync(keptFull), keptFull);
  check("the harness's own copy is excused", wroteIt(keptFull, startedAt) === true);
  check('an unkept attachment is not written', !fs.existsSync(path.join(dir, '.synapse', 'attachments', 'skipped.png')));

  // ── an answered question says so ──────────────────────────────
  forgetWrites();
  writeDoc(dir, { current: 'c', handover: '', notes: '', log: '### request · 9 Nov 2026, 21:00\nship it\n' });
  const doc = path.join(dir, '.synapse', 'project.md');
  check('the document is written', fs.existsSync(doc));
  check('the operator\'s answer landing in it is excused', wroteIt(doc, startedAt) === true);
  check('a worker writing the same file is still not excused by a stale mark', wroteIt(doc, Date.now() + 60_000) === false);

  // ── an alarm is called what it is ─────────────────────────────
  check(
    'a harness write says so',
    alarmTitle('WRITE INSIDE THE HARNESS') === 'Something tried to write inside Synapse',
    alarmTitle('WRITE INSIDE THE HARNESS'),
  );
  check(
    'a worker outside its folder says so',
    alarmTitle('WROTE INSIDE .synapse OUTSIDE ITS FOLDER') === 'A worker wrote outside its own folder',
    alarmTitle('WROTE INSIDE .synapse OUTSIDE ITS FOLDER'),
  );
  check(
    'a change during a run says so',
    alarmTitle('CHANGED DURING A WORKER RUN') === "Synapse's own files changed while a worker ran",
    alarmTitle('CHANGED DURING A WORKER RUN'),
  );
  check(
    'a shell command naming the harness still says that',
    alarmTitle('shell command naming the harness') === 'A model named Synapse in a tool call',
    alarmTitle('shell command naming the harness'),
  );
  check('two kinds do not share a title', alarmTitle('WRITE INSIDE THE HARNESS') !== alarmTitle('WROTE INSIDE .synapse OUTSIDE ITS FOLDER'));
  const shown = renderAlarm({ what: 'WROTE INSIDE .synapse OUTSIDE ITS FOLDER', paths: ['project.md'], note: 't9 (designer)' });
  check('the card carries the real title', shown.includes('A worker wrote outside its own folder'), shown.slice(0, 120));
  check('and the file it is about', shown.includes('project.md'));
  check('the raw constant is not the heading', !shown.includes('OUTSIDE ITS FOLDER</span>'), shown.slice(0, 140));
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  ${f}`);
process.exit(fails.length ? 1 : 0);
