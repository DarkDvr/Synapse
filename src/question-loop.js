// The same question, asked again.
//
// A worker that asks gets one answer from the operator, which the engine records
// as the tool's result. When the identical question comes back, the worker is not
// gathering information — it is looping, and the operator is being asked to answer
// the same thing twice. Measured on Shift Test 2: four asks, the same one three
// times, every answer stored and every answer ignored.
//
// The rule, and it is deliberately a show stopper:
//
//   1st ask   the operator answers.
//   2nd ask   answered here with the operator's own earlier answer, not shown.
//   3rd ask   the run is stopped with a reason the report carries.
//
// The third is loud on purpose: it is a model problem, and the operator wants to
// see it rather than be asked again.

/**
 * What a form is asking, in one comparable string.
 *
 * The field titles *and* the options: two forms that ask the same thing with a
 * different set of answers are different questions, and treating them as one made
 * the loop guard answer with an option the second form did not even offer
 * (3 Nov — "Single color" with a recommended Yellow came back Red, because the
 * history only remembered the title).
 */
export function questionSignature(form) {
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  const parts = fields
    .map((f) => {
      const title = String(f?.title || f?.key || '').trim();
      const options = (Array.isArray(f?.options) ? f.options : [])
        .map((o) => String(o?.value ?? o?.label ?? o ?? '').trim())
        .filter(Boolean)
        .join(',');
      return options ? `${title} [${options}]` : title;
    })
    .filter(Boolean);
  return parts.join(' | ') || String(form?.title || '').trim();
}

/**
 * What to do with this form, given what this session has already asked.
 *
 * `per` is the session's Map(signature -> { answer, asks }); it is read, not
 * written, so the caller stays the only place that records an ask.
 */
export function guardDecision(per, formId, signature) {
  if (!per || !formId || !signature) return { action: 'show' };
  const seen = per.get(signature);
  if (!seen) return { action: 'show' };
  const asks = (Number(seen.asks) || 1) + 1;
  if (asks >= 3) return { action: 'stop', asks, answer: seen.answer || {}, stopped: Boolean(seen.stopped) };
  return { action: 'auto', asks, answer: seen.answer || {} };
}

/** The answer as a sentence, for the report and the log. */
export function readableAnswer(answer) {
  const parts = Object.entries(answer || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  return parts.join('; ') || '(no answer recorded)';
}
