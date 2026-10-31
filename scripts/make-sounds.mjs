// The four "the Architect has finished" chimes, synthesised here.
//
//   node scripts\make-sounds.mjs
//
// They are written to `web\sounds\` as mono 16-bit WAV and served by the app itself,
// because Synapse fetches nothing at runtime (AGENTS.md, rule 2). Synthesising rather
// than downloading also settles the licence: these files are ours, and they are
// reproducible from this script, which is the only reason to keep the generator.
//
// Everything is quiet on purpose. The peak is about a sixth of full scale, which is
// a sound you notice and can talk over; the operator asked for subtle. The envelope
// is a short attack and an exponential decay — no sustain, so nothing rings for
// longer than it takes to say "done".
//
// Wanted instead: the Windows sounds are at C:\Windows\Media (Windows Notify.wav,
// Windows Chimes.wav, Windows Ding.wav) and can be added as more entries in
// web\sounds — but they are Microsoft's files, so this folder does not ship them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'sounds');
const RATE = 44100;

/** A mono 16-bit PCM WAV. */
function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const TAU = Math.PI * 2;
/** A note that starts at `at` and dies away: soft attack, exponential decay. */
function note(len, at, freq, { amp = 1, tau = 0.2, attack = 0.006, harmonics = [[1, 1]] } = {}) {
  const out = new Float32Array(len);
  const start = Math.round(at * RATE);
  for (let i = start; i < len; i++) {
    const t = (i - start) / RATE;
    const env = (1 - Math.exp(-t / attack)) * Math.exp(-t / tau);
    // The first sample of a soft attack is exactly zero; stopping on it would write
    // an empty note (learned the hard way — three files came out silent).
    if (t > 0.001 && env < 1e-4) break;
    let s = 0;
    for (const [mult, gain] of harmonics) s += gain * Math.sin(TAU * freq * mult * t);
    out[i] += s * env * amp;
  }
  return out;
}

const add = (a, b) => {
  for (let i = 0; i < a.length; i++) a[i] += b[i] || 0;
  return a;
};

/** Scale so the loudest sample is `peak`, and fade the last 8ms to silence. */
function finish(buf, peak) {
  let max = 0;
  for (const v of buf) max = Math.max(max, Math.abs(v));
  const k = max > 0 ? peak / max : 0;
  const fade = Math.round(RATE * 0.008);
  const n = buf.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tail = i > n - fade ? (n - i) / fade : 1;
    out[i] = buf[i] * k * tail;
  }
  return out;
}

const seconds = (s) => Math.round(s * RATE);

/** Two soft notes, rising: a doorbell you could work beside. */
function chime() {
  const len = seconds(0.9);
  const buf = new Float32Array(len);
  // A5 then E6: the interval is a fifth, which reads as "settled" rather than "alarm".
  const voice = [[1, 1], [2, 0.26], [3, 0.09]];
  add(buf, note(len, 0.0, 880.0, { amp: 1, tau: 0.24, harmonics: voice }));
  add(buf, note(len, 0.1, 1318.51, { amp: 0.8, tau: 0.26, harmonics: voice }));
  return finish(buf, 0.18);
}

/** One struck bell: inharmonic partials, long but quiet decay. */
function bell() {
  const len = seconds(1.2);
  const f = 523.25; // C5
  const buf = new Float32Array(len);
  const partials = [[1, 1, 0.42], [2.0, 0.4, 0.3], [2.76, 0.22, 0.2], [5.4, 0.09, 0.11]];
  for (const [mult, gain, tau] of partials) {
    add(buf, note(len, 0, f * mult, { amp: gain, tau, attack: 0.004 }));
  }
  return finish(buf, 0.15);
}

/** A soft knock on wood: a filtered noise tick over a low body. */
function wood() {
  const len = seconds(0.3);
  const buf = new Float32Array(len);
  // One-pole lowpass over the tick, so it is a "tock" and not a "tss".
  let low = 0;
  const a = 1 - Math.exp((-TAU * 1100) / RATE);
  let seed = 12345;
  for (let i = 0; i < seconds(0.05); i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = (seed / 0xffffffff) * 2 - 1;
    low += a * (noise - low);
    const t = i / RATE;
    // A 1.5ms ramp: a noise burst that starts at full amplitude is a click, and the
    // click is louder than the knock.
    const ramp = Math.min(1, t / 0.0015);
    buf[i] += low * ramp * Math.exp(-t / 0.006) * 1.6;
  }
  add(buf, note(len, 0, 190, { amp: 0.7, tau: 0.055, attack: 0.002 }));
  add(buf, note(len, 0, 480, { amp: 0.22, tau: 0.03, attack: 0.002 }));
  return finish(buf, 0.2);
}

/** Three very quiet plips, rising: the lightest of the four. */
function ripple() {
  const len = seconds(0.6);
  const buf = new Float32Array(len);
  const notes = [[0.0, 659.25], [0.085, 783.99], [0.17, 987.77]];
  for (const [at, f] of notes) add(buf, note(len, at, f, { amp: 1, tau: 0.11, attack: 0.003 }));
  return finish(buf, 0.13);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, make] of Object.entries({ chime, bell, wood, ripple })) {
  const file = path.join(OUT, `${name}.wav`);
  const data = wav(make());
  fs.writeFileSync(file, data);
  console.log(`${name}.wav  ${(data.length / 1024).toFixed(0)} KB`);
}
