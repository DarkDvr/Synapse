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

/**
 * One line for the brief. The model should not have to discover by being
 * refused, and a role that was given nothing should know that too.
 */
export function describeSkills(config, role) {
  const list = roleSkillList(config, role);
  if (list === null) return '';
  if (!list.length) return 'You have no skills: do the task with the tools you have.';
  return (
    `Skills you may use: ${list.join(', ')}. Load one with the skill tool when it fits the task; ` +
    `any other skill is refused.`
  );
}
