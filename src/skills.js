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
export function roleSkillList(config, role) {
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

/** The skills a role must load before it starts, or [] when none were set. */
export function roleMustLoad(config, role) {
  const entry = config?.roles?.[role];
  if (!entry || !Array.isArray(entry.mustLoad)) return [];
  return entry.mustLoad.map((s) => String(s || '').trim()).filter(Boolean);
}

/**
 * One line for the brief, in two parts: what must be loaded and what may be.
 *
 * In Shift Test 3 and 4 the brief said a role *may* load its skills — a
 * permission — and not one coder ever loaded `code-craft`. So the required list
 * is now an instruction, and the runner checks it (`skillsMissing` in runs.js).
 * The rest stay available without being mandatory: every skill read is context
 * spent, and a local model with a 28k room feels that.
 */
export function describeSkills(config, role) {
  const all = roleSkillList(config, role);
  if (all === null) return '';
  if (!all.length) return 'You have no skills: do the task with the tools you have.';
  const must = roleMustLoad(config, role);
  const optional = all.filter((s) => !must.includes(s));
  const before = role === 'architect' ? 'before you judge the next piece of work' : 'before your first edit';
  const parts = [];
  if (must.length) {
    parts.push(
      `Skills for this role — load every one of them with the skill tool ${before}: ${must.join(', ')}. They ` +
        `are how this role does its work, not optional reading, and a skill you skipped is part of the job you ` +
        `skipped.`,
    );
  }
  if (optional.length) parts.push(`Also available when the task needs it: ${optional.join(', ')}.`);
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
  // A Windows app is copied from the shell that ships here, not hand-rolled: the
  // parts that are easy to get wrong (DPI, the dark frame, the https origin for the
  // UI, the single-file publish) are already right in it. Only mentioned to a role
  // that can check a window, because that is the role that builds one.
  if (all.includes('app-check')) {
    parts.push(
      `A Windows app is copied from the shell that ships with Synapse, at ` +
        `${path.join(ROOT, 'templates', 'win-app')} — copy that folder into the project and work in ` +
        `its ui\\ folder. Do not write a new WPF project from scratch.`,
    );
  }
  parts.push('Any other skill is refused. Say in your report which ones you loaded.');
  return parts.join(' ');
}
