// The project's living document: one file that holds what the operator asked,
// what was decided, the operator's own standing notes, the handover from the
// last compact, and the append-only log underneath.
//
// It replaces two files. `requirement.md` was the operator's words, verbatim and
// append-only; `decisions.md` was the answers to the questions the roles asked.
// Both still exist for projects written before this, and both are imported here
// on first use (see migrate below). The reason to merge them was the brief: it
// quotes one block, and with two files and no head that block was the *first*
// 1,600 characters of the project's life — the original request, forever.
//
// The rule that shapes the file: Synapse writes the operator's words and the
// facts, and a model writes nothing here. The head is rebuilt from the log, so
// it cannot drift from what was actually said. Only `## Handover` carries a
// model's summary, and it is labelled as the last compact's handover.
//
// Sections are delimited by HTML comments because the Notes section is the
// operator's own prose: a `##` heading inside it must not be read as a section.
import fs from 'node:fs';
import path from 'node:path';

/** Mirrors PLAN_DIR in plans.js — kept here so this module imports nothing. */
const SYNAPSE_DIR = '.synapse';
export const DOC_NAME = 'project.md';
export const DOC_RELATIVE = `${SYNAPSE_DIR}/${DOC_NAME}`;
const LEGACY_REQUEST = 'requirement.md';
const LEGACY_DECISIONS = 'decisions.md';
const ARCHIVE_DIR = `${SYNAPSE_DIR}/archive`;

const MARK = {
  current: ['<!-- synapse:current -->', '<!-- /synapse:current -->'],
  handover: ['<!-- synapse:handover -->', '<!-- /synapse:handover -->'],
  notes: ['<!-- synapse:notes -->', '<!-- /synapse:notes -->'],
  log: ['<!-- synapse:log -->', '<!-- /synapse:log -->'],
};

const MAX_REQUEST = 800;
const MAX_DECISIONS = 12;
const MAX_DECISION_CHARS = 1400;
const MAX_NOTE = 1000;

const docPath = (dir) => path.join(String(dir || ''), SYNAPSE_DIR, DOC_NAME);

/** "27 Oct 2026, 16:20" — the stamp every entry carries. */
export function stampOf(at = Date.now()) {
  const d = new Date(at);
  const month = d.toLocaleString('en-GB', { month: 'short' });
  return `${d.getDate()} ${month} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

const clip = (text, n) => {
  const s = String(text || '').trim();
  return s.length > n ? `${s.slice(0, n).trimEnd()} […]` : s;
};

/** Everything between one marker pair, or null when the file has no such pair. */
function sectionOf(raw, [start, end]) {
  const a = raw.indexOf(start);
  if (a === -1) return null;
  const from = a + start.length;
  const b = raw.indexOf(end, from);
  if (b !== -1) return raw.slice(from, b).replace(/^\n+/, '').replace(/\n+$/, '');
  // A missing end marker is a file somebody edited by hand: take what is there
  // up to the next section rather than losing the rest of the document.
  const next = Object.values(MARK)
    .map(([s]) => raw.indexOf(s, from))
    .filter((i) => i !== -1)
    .sort((x, y) => x - y)[0];
  return raw.slice(from, next === undefined ? raw.length : next).replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * Read the document. `ok` is false when the file exists but cannot be read as
 * one of ours; nothing may overwrite that, because the operator may have opened
 * it and typed.
 *
 * Section headings live in the file for a human, and are stripped here: the
 * values this module passes around are the content, and the renderer puts the
 * headings back. Otherwise every write would add another `## Notes`.
 */
export function readDoc(dir) {
  const target = docPath(dir);
  const empty = { exists: false, ok: true, path: target, current: '', handover: '', notes: '', log: '' };
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  } catch (err) {
    if (err.code === 'ENOENT') return empty;
    return { ...empty, ok: false, error: `could not read it: ${err.message}` };
  }
  const headings = { current: 'Current', handover: 'Handover', notes: 'Notes', log: 'Log' };
  const parts = {};
  for (const [name, pair] of Object.entries(MARK)) {
    const body = sectionOf(raw, pair);
    parts[name] =
      body === null ? null : body.replace(new RegExp(`^## ${headings[name]}\\s*\\n+`), '').replace(/\n+$/, '');
  }
  if (Object.values(parts).every((v) => v === null)) {
    return { ...empty, exists: true, ok: false, error: 'it has no section markers' };
  }
  return {
    exists: true,
    ok: true,
    path: target,
    current: parts.current || '',
    handover: parts.handover || '',
    notes: parts.notes || '',
    log: parts.log || '',
  };
}

function renderDoc({ dir, current, handover, notes, log }) {
  const title = path.basename(String(dir || '')) || 'project';
  const bodies = { current, handover, notes, log };
  const headings = { current: 'Current', handover: 'Handover', notes: 'Notes', log: 'Log' };
  const block = (name) => {
    const body = String(bodies[name] || '').trim();
    return `${MARK[name][0]}\n## ${headings[name]}\n${body ? `\n${body}\n` : ''}${MARK[name][1]}`;
  };
  return [
    `# ${title} — project document`,
    '',
    '<!-- Synapse maintains Current and Handover. Notes is yours: anything the',
    '     next conversation should be told every turn. The Log is append-only and',
    '     holds every request and every answer, verbatim. -->',
    '',
    block('current'),
    '',
    block('handover'),
    '',
    block('notes'),
    '',
    block('log'),
    '',
  ].join('\n');
}

/** Write the whole document, atomically where the filesystem allows it. */
export function writeDoc(dir, { current = '', handover = '', notes = '', log = '' }) {
  const target = docPath(dir);
  const text = renderDoc({ dir, current, handover, notes, log });
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, target);
    } catch {
      // A Windows rename can lose to a reader holding the file; writing the real
      // path once more is slower and still correct, and the temporary goes.
      fs.writeFileSync(target, text, 'utf8');
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    }
    return true;
  } catch {
    return false;
  }
}

// ── the log and the head ────────────────────────────────────────

const ENTRY = /^### (request|chat|decision|compact) · (.+)$/;

/** Split the Log into entries: a heading line plus the body under it. */
export function parseLog(log) {
  const out = [];
  let current = null;
  for (const line of String(log || '').split('\n')) {
    const m = ENTRY.exec(line);
    if (m) {
      if (current) out.push(current);
      current = { kind: m[1], stamp: m[2].trim(), body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) out.push(current);
  return out.map((e) => ({ ...e, body: e.body.replace(/^\n+/, '').replace(/\n+$/, '') }));
}

const ROW = /^- \*\*(.+?)\*\* -> (.*)$/;

/** The latest value of every question ever answered, oldest first. */
function decisionsInForce(entries) {
  const byTitle = new Map();
  for (const entry of entries) {
    if (entry.kind !== 'decision') continue;
    for (const line of entry.body.split('\n')) {
      const m = ROW.exec(line.trim());
      if (!m) continue;
      const title = m[1].trim();
      byTitle.set(title.toLowerCase(), { title, value: m[2].trim(), stamp: entry.stamp });
    }
  }
  return [...byTitle.values()];
}

/** The head the brief quotes: the current ask and the decisions still standing. */
export function buildCurrent(log, { at = Date.now() } = {}) {
  const entries = parseLog(log);
  const requests = entries.filter((e) => e.kind === 'request');
  const chats = entries.filter((e) => e.kind === 'chat');
  const latest = requests.length ? requests[requests.length - 1] : chats[chats.length - 1] || null;
  const decisions = decisionsInForce(entries);

  const lines = ['Request: ' + (latest ? clip(latest.body, MAX_REQUEST) : 'none yet.')];
  if (!decisions.length) {
    lines.push('Decisions in force: none yet.');
  } else {
    lines.push('Decisions in force:');
    let spent = 0;
    let shown = 0;
    for (const d of decisions) {
      if (shown >= MAX_DECISIONS) break;
      const row = `- ${clip(d.title, 120)} -> ${clip(d.value, 300)} (${d.stamp})`;
      if (spent + row.length > MAX_DECISION_CHARS) break;
      lines.push(row);
      spent += row.length;
      shown += 1;
    }
    if (shown < decisions.length) lines.push(`- …and ${decisions.length - shown} more in the Log.`);
  }
  lines.push(`${at ? `Updated: ${stampOf(at)}` : ''}`.trim() || '');
  // A legacy project is read before it is written: there is no update time to
  // report, so the line is left out rather than saying "updated now" every time.
  return lines.filter((line) => line !== '').join('\n');
}

function entryText(kind, stamp, body) {
  return `### ${kind} · ${stamp}\n${String(body || '').trim()}\n`;
}

function appendBlock(log, block) {
  const base = String(log || '').replace(/\s+$/, '');
  return base ? `${base}\n\n${block}` : block;
}

// ── what was there before this file ─────────────────────────────

/** Read the two old files as one log, without writing anything. */
function readLegacy(dir) {
  const log = [];
  let requirement = '';
  let decisions = '';
  try {
    requirement = fs.readFileSync(path.join(String(dir || ''), SYNAPSE_DIR, LEGACY_REQUEST), 'utf8');
  } catch { /* not there */ }
  try {
    decisions = fs.readFileSync(path.join(String(dir || ''), SYNAPSE_DIR, LEGACY_DECISIONS), 'utf8');
  } catch { /* not there */ }

  const blocks = requirement
    .replace(/^# The operator's request\s*\n+/, '')
    .split(/\n---\n/)
    .map((b) => b.replace(/^\n+/, '').trim())
    .filter(Boolean);
  for (const body of blocks) log.push(entryText('request', 'migrated', body));

  // "## 26 Oct 2026, 22:41 - <signature>" then "- **title** -> value" rows.
  const parts = decisions.split(/^## /m).slice(1);
  for (const part of parts) {
    const [head, ...rest] = part.split('\n');
    const stamp = head.replace(/\s+-\s+[0-9a-f]{4,}$/i, '').trim() || 'migrated';
    const rows = rest.filter((line) => ROW.test(line.trim()));
    if (rows.length) log.push(entryText('decision', stamp, rows.join('\n')));
  }
  return { log: log.join('\n\n'), hadRequirement: Boolean(requirement.trim()), hadDecisions: Boolean(decisions.trim()) };
}

/** Move the two old files aside once their words are safely in the document. */
function archiveLegacy(dir) {
  const from = path.join(String(dir || ''), SYNAPSE_DIR);
  const to = path.join(String(dir || ''), SYNAPSE_DIR, 'archive');
  try { fs.mkdirSync(to, { recursive: true }); } catch { return; }
  for (const name of [LEGACY_REQUEST, LEGACY_DECISIONS]) {
    const src = path.join(from, name);
    if (!fs.existsSync(src)) continue;
    try {
      fs.copyFileSync(src, path.join(to, name));
      fs.unlinkSync(src);
    } catch { /* the words are in the document; a copy that failed is not fatal */ }
  }
}

/**
 * Make sure the document exists, importing the old files the first time.
 * Returns the doc, or null when there is nothing to write yet.
 */
export function ensureProjectDoc(dir) {
  if (!dir) return null;
  const existing = readDoc(dir);
  if (existing.exists) return existing;
  const legacy = readLegacy(dir);
  if (!legacy.log) return existing; // a new project: the first request creates it
  const log = legacy.log;
  const ok = writeDoc(dir, { current: buildCurrent(log), handover: '', notes: '', log });
  if (!ok) return { ...existing, ok: false, error: 'could not write it' };
  archiveLegacy(dir);
  return readDoc(dir);
}

// ── writing ─────────────────────────────────────────────────────

/**
 * Append one entry and rebuild the head. `kind` is `request` for a Multi message
 * (the project's asks), `chat` for a Single one, `decision` for an answer.
 */
export function appendEntry(dir, kind, body, { at = Date.now() } = {}) {
  if (!dir) return { ok: false, error: 'no project' };
  if (!String(body || '').trim()) return { ok: false, error: 'nothing to write' };
  const migrated = ensureProjectDoc(dir);
  if (migrated && migrated.exists && !migrated.ok) return { ok: false, error: migrated.error };
  const doc = readDoc(dir);
  if (doc.exists && !doc.ok) return { ok: false, error: doc.error };
  const stamp = stampOf(at);
  const log = appendBlock(doc.log, entryText(kind, stamp, body));
  const ok = writeDoc(dir, {
    current: buildCurrent(log, { at }),
    handover: doc.handover,
    notes: doc.notes,
    log,
  });
  return ok ? { ok: true, stamp, log, path: doc.path } : { ok: false, error: 'could not write it' };
}

/** The operator's Multi message, verbatim. The project's current request. */
export function appendRequest(dir, text, opts) {
  return appendEntry(dir, 'request', text, opts);
}

/** A Single-mode message: logged, but never the project's request. */
export function appendChat(dir, text, opts) {
  return appendEntry(dir, 'chat', text, opts);
}

/**
 * The operator's answer to a question a role asked: settled, in their words.
 * "(Recommended)" is the Architect's nudge, not their decision, so it is dropped
 * — the same rule the old decisions file had.
 */
export function appendDecision(dir, { at = Date.now(), fields = [], answer = {} } = {}) {
  const rows = (Array.isArray(fields) ? fields : [])
    .map((f) => {
      const key = String(f?.key || f?.name || '').trim();
      const title = String(f?.title || key).trim();
      const said = answer?.[key];
      const raw = Array.isArray(said) ? said.join(', ') : said == null ? '' : String(said);
      const value = raw.replace(/\s*\(recommended\)/gi, '').trim();
      return value ? `- **${title}** -> ${value}` : `- **${title}** -> (left blank)`;
    })
    .filter(Boolean);
  if (!rows.length) return { ok: false, error: 'no fields' };
  return appendEntry(dir, 'decision', rows.join('\n'), { at });
}

/** Replace the handover (the last compact's summary). Phase 3 writes this. */
export function setHandover(dir, text, { at = Date.now() } = {}) {
  if (!dir) return false;
  const migrated = ensureProjectDoc(dir);
  if (migrated && migrated.exists && !migrated.ok) return false;
  const doc = readDoc(dir);
  const log = doc.log;
  return writeDoc(dir, {
    current: buildCurrent(log, { at }),
    handover: String(text || '').trim(),
    notes: doc.notes,
    log,
  });
}

/**
 * What the brief quotes: the current ask and decisions, the operator's notes and
 * the last handover — each bounded, because the brief is re-sent every turn.
 * Falls back to the old files when the document has not been created yet.
 */
export function digest(dir) {
  const doc = readDoc(dir);
  const plain = (text) => String(text || '').replace(/^## Current\s*\n+/, '').trim();
  if (doc.exists && doc.ok) {
    return {
      exists: true,
      path: doc.path,
      current: plain(doc.current),
      notes: doc.notes,
      handover: doc.handover,
      log: doc.log,
    };
  }
  if (doc.exists && !doc.ok) {
    return { exists: true, path: doc.path, current: '', notes: '', handover: '', log: '', error: doc.error };
  }
  const legacy = readLegacy(dir);
  return {
    exists: false,
    path: doc.path,
    current: legacy.log ? plain(buildCurrent(legacy.log, { at: 0 })) : '',
    notes: '',
    handover: '',
    log: legacy.log,
  };
}

export const LIMITS = { request: MAX_REQUEST, decisions: MAX_DECISION_CHARS, note: MAX_NOTE };
