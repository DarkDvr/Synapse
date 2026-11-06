// A number said as a word: 212k, 1.4M, 00:04:31.
//
// These two lived at the top of runs.js. When the report writer moved out to
// report.js it took the code that calls `tokens` and left the definition behind —
// and nothing said so. A free name in a moved function is not a boot error and not
// a syntax error: it is a ReferenceError the first time that branch runs, five
// seconds after a worker finishes, where the only trace is one line in the log.
// So the formatters live beside neither file now, and tests/report.test.mjs walks
// every branch of the report to keep them honest.

/** Token counts read as words, not as digits: 212k, 1.4M. */
export const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

/** How long a run took, in the same HH:MM:SS the role cards' clocks use. */
export function ranFor(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}
