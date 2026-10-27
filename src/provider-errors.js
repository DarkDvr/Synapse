// Provider failures: how to read them, and the one file that remembers them.
//
// A turn can end with an error sentence instead of a result. Almost all of them
// are the provider's servers having a bad minute — a rate limit at peak time, a
// reset connection, a 502 from a proxy — and the right answer is to wait and try
// the same turn again. A few are final: the model was retired, the key is wrong,
// the request itself is malformed. Retrying those only spends the operator's
// night.
//
// This file is the *only* place that decides which is which, and the only writer
// of `data\provider-errors.log`.
//
// Why its own file, with its own retention:
//   The operator asked to see the pattern over weeks — "evenings are slow" is a
//   claim that needs a month of evidence, not a rotating app log. So this file is
//   pruned by age (30 days) regardless of `logging.retentionDays`, and every line
//   is one short record so a month of them stays a few hundred kilobytes. It is
//   written on failure only; nothing is sampled and nothing is repeated while a
//   retry loop is merely waiting.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export const PROVIDER_LOG = path.join(DATA_DIR, 'provider-errors.log');
/** Days of history to keep. Deliberately not a setting: the point is to see
 *  months, and the file stays small because a line is ~140 characters. */
export const PROVIDER_LOG_DAYS = 30;
const MESSAGE_MAX = 180;
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Which kind of failure is this, and does retrying help?
 *
 * Order matters. "Model X has been deprecated" also contains nothing transient,
 * but "no longer available" would otherwise match the server rule below — so the
 * terminal rules are tested first and each answer is a *reason* rather than a
 * guess: the incident log is read months later and "rate-limit" is evidence where
 * "transient" is not.
 */
const RULES = [
  {
    // The session (or the folder it ran in) no longer exists. That is the operator
    // deleting it — stopped the run, deleted the session, removed the project — so
    // no retry can succeed and there is nothing to report as a failure either.
    // The runner ends the run as `stopped` when it sees this reason. Before this
    // rule, "404 Session not found" fell through to `unknown`, was treated as
    // transient, and the Architect card sat on "Retrying at …" for a session
    // that had been gone for minutes.
    reason: 'gone',
    kind: 'terminal',
    re: /session not found|no such session|unknown session|session (?:has been |was )?deleted|session does not exist|location not found/i,
  },
  {
    reason: 'deprecated',
    kind: 'terminal',
    re: /deprecat|retired|no longer (available|supported)|not available|no such model|model not found|unknown model|does not exist/i,
  },
  {
    reason: 'auth',
    kind: 'terminal',
    re: /unauthori[sz]ed|invalid api key|invalid key|authentication failed|forbidden|\b40[13]\b/i,
  },
  {
    // Before `bad-request`, because an over-long prompt is usually reported as a
    // 400 and "retry the same request" can never fix it. It is not terminal
    // either: a compaction makes it fit, and the work carries on. A local server
    // set to "Stop at Limit" answers exactly this way instead of truncating.
    reason: 'context',
    kind: 'context',
    re: /context (length|window|limit|size)|maximum context|context_length_exceeded|prompt is too (long|large)|too many tokens|exceeds? (the )?(model'?s )?(maximum|context)|exceeds the available context|input is too long/i,
  },
  {
    reason: 'bad-request',
    kind: 'terminal',
    re: /invalid request|bad request|\b400\b|unprocessable|\b422\b|validation (error|failed)/i,
  },
  {
    // A free plan's usage cap, not a pace limit. It can clear on its own — t8
    // recovered after about five minutes of retries on 27 Oct — so it is retried,
    // but the runner gives it a bounded grace (USAGE_LIMIT_MS) and then stops
    // with "switch models": t9 retried the same sentence 13 times over 51 minutes
    // before the operator stopped it, because it classified as `unknown`.
    reason: 'usage-limit',
    kind: 'transient',
    re: /free usage limit|usage limit reached|out of (?:credits|quota)|subscribe to .*keep going|switch models/i,
  },
  {
    reason: 'rate-limit',
    kind: 'transient',
    re: /rate.?limit|rate limited|\b429\b|too many requests|quota|capacity|overloaded|free tier/i,
  },
  {
    reason: 'server',
    kind: 'transient',
    re: /\b5\d\d\b|internal (server )?error|service unavailable|temporarily unavailable|try again|unavailable/i,
  },
  {
    reason: 'connection',
    kind: 'transient',
    re: /connection|econnreset|econnrefused|econnaborted|socket|network|fetch failed|\bdns\b|enotfound|etimedout|timed out|hang up|broken pipe/i,
  },
];

/**
 * Classify a provider's error sentence.
 *
 * `{ kind: 'transient' | 'terminal', reason }`. An unrecognised sentence is
 * transient on purpose: a new way for the server to say "not now" must not end a
 * run at 3am, and an operator can stop a loop that is going nowhere.
 */
export function classifyFailure(message) {
  const text = String(message ?? '');
  for (const rule of RULES) {
    if (rule.re.test(text)) return { kind: rule.kind, reason: rule.reason };
  }
  return { kind: 'transient', reason: 'unknown' };
}

const oneLine = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/"/g, "'")
    .trim()
    .slice(0, MESSAGE_MAX);

/**
 * One line per failure: when, what kind, which role and model, which turn, and
 * the provider's own words. `role` / `model` / `task` may be empty for a wake.
 */
export function recordProviderError({ message, classification, role, model, task, attempt, note } = {}) {
  const cls = classification || classifyFailure(message);
  const at = new Date().toISOString();
  const fields = [
    at,
    cls.kind,
    cls.reason,
    role ? `role=${role}` : '',
    model ? `model=${model}` : '',
    task ? `task=${task}` : '',
    attempt ? `retry=${attempt}` : '',
    note ? `note=${oneLine(note)}` : '',
  ].filter(Boolean);
  const line = `${fields.join(' | ')} | "${oneLine(message)}"\n`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(PROVIDER_LOG, line, 'utf8');
  } catch {
    /* never let the diary break the run */
  }
  pruneProviderLog();
  return line;
}

let lastPrune = 0;

/**
 * Delete records older than 30 days. Cheap enough to run on every write (it is
 * throttled to every six hours) and at boot, so the file cannot grow without
 * bound on a machine that never restarts.
 */
export function pruneProviderLog(force = false) {
  if (!force && Date.now() - lastPrune < PRUNE_EVERY_MS) return 0;
  lastPrune = Date.now();
  let text;
  try {
    text = fs.readFileSync(PROVIDER_LOG, 'utf8');
  } catch {
    return 0;
  }
  const cutoff = Date.now() - PROVIDER_LOG_DAYS * 24 * 60 * 60 * 1000;
  const keep = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const at = Date.parse(line.slice(0, 24));
    if (Number.isFinite(at) && at < cutoff) {
      dropped += 1;
      continue;
    }
    keep.push(line);
  }
  if (!dropped) return 0;
  try {
    const tmp = `${PROVIDER_LOG}.tmp`;
    fs.writeFileSync(tmp, keep.length ? `${keep.join('\n')}\n` : '', 'utf8');
    fs.renameSync(tmp, PROVIDER_LOG);
  } catch {
    return 0;
  }
  return dropped;
}
