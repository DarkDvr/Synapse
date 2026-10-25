// What an outgoing message may carry.
//
// The operator can attach any file, so this is the one place between their disk
// and a provider that decides what is small enough to send and what shape the
// engine will accept. It must never throw: the sentence matters more than the file.
import { normalizeAttachments } from '../src/api.js';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const b64 = (bytes) => Buffer.alloc(bytes, 0x41).toString('base64');

{
  const out = normalizeAttachments([
    { name: 'notes.txt', mime: 'text/plain', data: b64(12) },
    { name: 'photo.png', mime: 'image/png', data: `data:image/png;base64,${b64(8)}` },
  ]);
  check('a plain attachment is kept', out.length === 2 && out[0].name === 'notes.txt', JSON.stringify(out.map((f) => f.name)));
  check('the data: prefix is stripped', !out[1].data.startsWith('data:'), out[1].data.slice(0, 12));
  check('the name and mime travel with it', out[1].name === 'photo.png' && out[1].mime === 'image/png');
}

{
  check('nothing sent is nothing kept', normalizeAttachments(undefined).length === 0);
  check('a string is not a list', normalizeAttachments('nope').length === 0);
  check('an entry with no bytes is dropped', normalizeAttachments([{ name: 'x' }]).length === 0);
  check('bytes that are not base64 are dropped', normalizeAttachments([{ name: 'x', data: 'not base64!!' }]).length === 0);
  const missingMime = normalizeAttachments([{ name: 'a.bin', data: b64(4) }]);
  check('a missing mime gets a safe default', missingMime[0]?.mime === 'application/octet-stream', missingMime[0]?.mime);
  const noName = normalizeAttachments([{ data: b64(4) }]);
  check('a missing name gets one', noName[0]?.name === 'attachment', noName[0]?.name);
}

{
  // 8 MB before base64; one byte over is refused, and the others still go.
  const ok = normalizeAttachments([{ name: 'big', data: b64(8 * 1024 * 1024) }]);
  const tooBig = normalizeAttachments([{ name: 'big', data: b64(8 * 1024 * 1024 + 1) }]);
  check('8 MB is allowed', ok.length === 1);
  check('a byte over 8 MB is refused', tooBig.length === 0, `${tooBig.length}`);
  const mixed = normalizeAttachments([
    { name: 'huge', data: b64(9 * 1024 * 1024) },
    { name: 'small', data: b64(10) },
  ]);
  check('a refused file does not take the rest with it', mixed.length === 1 && mixed[0].name === 'small');
}

{
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `f${i}`, data: b64(10) }));
  const out = normalizeAttachments(many);
  check('six is the ceiling for one message', out.length === 6, String(out.length));
  const longName = normalizeAttachments([{ name: 'a'.repeat(400), data: b64(4) }]);
  check('a huge name is cut to 120', longName[0].name.length === 120, String(longName[0].name.length));
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
