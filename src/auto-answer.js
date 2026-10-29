// What "Full auto" answers when the operator is away.
//
// The question tool's convention (and the brief's) is that the recommended
// option's label ends with " (Recommended)" and comes first. Full auto takes
// that option; with no recommendation it takes the first, which is the top row
// the operator would have seen. A multi-select takes every recommended option
// (one is the common case), or just the top one when none is marked.
//
// Free text and numbers have no option to recommend: the field's own default is
// used, and an empty string or null otherwise. A dropdown or a radio question
// always has options, so that fallback is for the rare free-text question.
export const FULL_AUTO_MS = 20_000;

/**
 * How long Full auto waits before it answers for the operator, in milliseconds.
 *
 * The setting is `fullAuto.timeoutSec` in the config file, in seconds. Zero is
 * deliberate and means "do not show the card at all": a permission is allowed
 * the moment the policy asks, because a full-auto operator has already said yes.
 * A missing or unreadable value falls back to 20 seconds.
 */
export function fullAutoTimeoutMs(config) {
  const value = config?.fullAuto?.timeoutSec;
  if (value === undefined || value === null || value === '') return FULL_AUTO_MS;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : FULL_AUTO_MS;
}

const isRecommended = (option) =>
  /\(recommended\)/i.test(String(option?.label || '')) || /\(recommended\)/i.test(String(option?.value || ''));

/** The answer object for one form, in the engine's reply shape. Null if the form
 *  asks nothing answerable (no fields, or only external/hidden ones). */
export function autoAnswerFor(form) {
  const answer = {};
  for (const field of form?.fields || []) {
    if (!field || field.hidden || field.type === 'external') continue;
    const key = String(field.key ?? '');
    if (!key) continue;
    const type = String(field.type || 'string');
    const options = Array.isArray(field.options) ? field.options : [];
    const recommended = options.filter(isRecommended);

    if (type === 'boolean') {
      answer[key] = true;
    } else if (type === 'multiselect') {
      const chosen = recommended.length ? recommended : options.slice(0, 1);
      answer[key] = chosen.map((option) => option.value);
    } else if (options.length) {
      const pick = recommended[0] || options[0];
      answer[key] = pick ? pick.value : '';
    } else if (type === 'number' || type === 'integer') {
      answer[key] = field.default != null && field.default !== '' ? Number(field.default) : null;
    } else {
      answer[key] = field.default != null ? String(field.default) : '';
    }
  }
  return Object.keys(answer).length ? answer : null;
}
