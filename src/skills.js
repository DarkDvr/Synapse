// Per-role skills.
//
// The engine has one `skills.paths` for every session, so a role's list cannot
// be expressed at install time — the only per-role lever is the session's own
// permission ruleset. Three engine facts make that enough (all measured on
// 2.0.30, in a scratch session):
//
//   {action:'*',     resource:'probe-denied', effect:'deny'}  -> the skill tool
//       answers "Permission denied: skill (type: permission.rejected)".
//   {action:'skill', resource:'*',            effect:'deny'}  -> every skill is
//       refused, which is what lets a list be fail-closed.
//   {action:'skill', resource:'visual-review',effect:'allow'} -> allowed, because
//       the engine takes the LAST matching rule.
//
// So a role with a list gets: deny every skill, then allow the ones it was given.
// A skill added to the folder tomorrow is denied until the role is granted it,
// which is the right default once somebody has been explicit about a role.
//
// No list at all means no restriction, which is what every role had before this
// existed. An explicit empty list means "no skills" and is kept as a choice.

import path from 'node:path';

import { ROOT, SKILLS_DIR } from './paths.js';

/** Skills that carry a script, and the file a role should run. */
const SHIPPED_TOOLS = {
  'visual-review': 'shot.mjs',
  'app-check': 'app-check.mjs',
};

/** The configured list for a role, or null when it was never set. */
function roleSkillList(config, role) {
  const entry = config?.roles?.[role];
  if (!entry || !Array.isArray(entry.skills)) return null;
  return entry.skills.map((s) => String(s || '').trim()).filter(Boolean);
}

/** Permission rules for one role. Empty when the role has no list. */
export function skillRules(config, role) {
  const list = roleSkillList(config, role);
  if (list === null) return [];
  const rules = [{ action: 'skill', resource: '*', effect: 'deny' }];
  for (const name of list) rules.push({ action: 'skill', resource: name, effect: 'allow' });
  return rules;
}

/**
 * The skill ruleset for a project's chat session.
 *
 * Single is a conversation with one model and no team, and it may meet any kind of
 * work — a web page, a Windows app, a document, a CLI. Its role list used to be the
 * Architect's, which is chosen for judging a team, so a Single chat could not load the
 * skills its own work needed while the engine went on advertising them all: on 28 Nov
 * the model read `frontend-design` in the tool list and was refused it, then spent a
 * turn guessing which skills were secretly allowed. Single now has no restriction at
 * all — no rules is the engine's own "load anything" — and the brief names what the
 * machine has. Multi keeps the Architect's list, because there the Architect's job is
 * judging work the roles did.
 */
export function chatSkillRules(config, single) {
  return single ? [] : skillRules(config, 'architect');
}

/** The skills a role must load before it starts, or [] when none were set.
 *
 * A required name that is not in the role's allowed list is not demanded: the
 * engine's ruleset denies it, so the brief would be asking for something no role
 * can do. The role dialog already keeps `mustLoad` a subset of `skills`; this also
 * holds for a hand-edited config (17 Nov: the Architect reported three required
 * designer skills that had been withdrawn from the session). */
export function roleMustLoad(config, role) {
  const entry = config?.roles?.[role];
  if (!entry || !Array.isArray(entry.mustLoad)) return [];
  const must = entry.mustLoad.map((s) => String(s || '').trim()).filter(Boolean);
  const allowed = roleSkillList(config, role);
  return allowed === null ? must : must.filter((s) => allowed.includes(s));
}

/**
 * One line for the brief, in two parts: what must be loaded and what may be.
 *
 * In Shift Test 3 and 4 the brief said a role *may* load its skills — a
 * permission — and not one coder ever loaded `code-craft`. So the required list
 * is now an instruction, and the runner checks it (`skillsMissing` in runs.js).
 * The rest stay available without being mandatory: every skill read is context
 * spent, and a local model with a 28k room feels that.
 *
 * `chat` is Single mode, which is not this harness: there is no role to judge and
 * no report to write, so the wording must not say either. Left as it was, a Single
 * session was told to load its skills "before you judge the next piece of work"
 * and to say so "in your report" — the Architect's words in a plain conversation.
 * Single is also not the Architect: `available` is the machine's own catalogue (the
 * engine's list, built-ins excluded), because every one of them is open to it and a
 * chat may meet any kind of work.
 */
export function describeSkills(config, role, { chat = false, available = null } = {}) {
  const list = chat
    ? (Array.isArray(available) ? available.map((s) => String(s || '').trim()).filter(Boolean) : [])
    : roleSkillList(config, role);
  if (list === null) return '';
  const all = list;
  if (chat && !all.length) {
    // The catalogue could not be read. Still true, and it does not name a list that
    // might be the wrong one: Single has no restriction, so the tool's own list stands.
    return 'Skills: the skill tool lists what this machine has and every one is open to you — load any of them when the work needs it.';
  }
  if (!all.length) return 'You have no skills: do the task with the tools you have.';
  const must = chat ? [] : roleMustLoad(config, role);
  const optional = all.filter((s) => !must.includes(s));
  const before = chat
    ? 'before you start'
    : role === 'architect'
      ? 'before you judge the next piece of work'
      : 'before your first edit';
  const parts = [];
  if (chat) {
    parts.push(
      `Skills — this machine has these, and every one of them is open to you: ${all.join(', ')}. ` +
        `Load any of them with the skill tool when the work needs it; a skill you skip is a capability the ` +
        `work went without.`,
    );
  } else if (must.length) {
    parts.push(
      `Skills for this role — load every one of them with the skill tool ${before}: ${must.join(', ')}. ` +
        `They are how this role does its work, not optional reading, and a skill you skipped is part of ` +
        `the job you skipped.`,
    );
  }
  if (optional.length && !chat) parts.push(`Also available when the task needs it: ${optional.join(', ')}.`);
  // A skill that ships a script cannot say where the script is: the folder is
  // true on one machine and false on the next. In Timer Test 1 the visual-review
  // skill named the operator's own skills folder, which does not carry it here —
  // so the designer, a coder and QC each searched the disk for `shot.mjs`, tripped
  // the harness alarm doing it, and then called the tool with a flag it does not
  // have. The path is the harness's fact, so the harness says it.
  for (const [skill, tool] of Object.entries(SHIPPED_TOOLS)) {
    if (!all.includes(skill)) continue;
    const full = path.join(SKILLS_DIR, skill, 'bin', tool);
    parts.push(
      `The ${skill} tool ships with Synapse and its full path is ${full} — run that file with node, as ` +
        `the skill says. It is the only copy: do not search the disk for another one.`,
    );
  }
  // A Windows app is built from the `win-app` skill, which ships the shell (WPF +
  // WebView2) and the build steps. It used to be `templates/win-app` — Synapse's own
  // folder — so a model building an app had to read the harness, which is off limits
  // by design (7 Nov). The skill is the source now, and the only one.
  if (all.includes('win-app')) {
    parts.push(
      `A Windows app is built from the win-app skill: it carries the shell to copy into the project ` +
        `(its template folder) and the build steps. Do not write a new WPF project from scratch, and ` +
        `do not go looking for the shell in Synapse's own folders.`,
    );
  } else if (all.includes('app-check')) {
    parts.push(`A Windows app's window is verified with the app-check skill once it is built.`);
  }
  // In a chat nothing is refused: the list above is what the machine has, and the
  // tool will load any of it. In a role, the list is the whole permission.
  parts.push(
    chat
      ? 'The list above is this machine’s library: do not hunt the disk for skills, and say so if one you need is missing.'
      : 'Any other skill is refused. Say in your report which ones you loaded.',
  );
  return parts.join(' ');
}
