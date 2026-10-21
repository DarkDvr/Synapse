// The question-loop rule, as a pure decision.
//
// Shift Test 2 asked the same question four times and every answer was recorded
// and ignored. The operator wants that to be visible: the second ask is answered
// for them, the third stops the run.
import { questionSignature, guardDecision, readableAnswer } from '../src/question-loop.js';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

const form = (title, id = 'f1') => ({
  id,
  sessionID: 'ses_x',
  title: 'Input needed',
  fields: [{ key: '0', title }],
});
const other = (title, id = 'f2') => ({ ...form(title, id) });

// The signature is what the worker asked, not the form's id.
check('the same question has the same signature', questionSignature(form('How should the report be structured?')) === questionSignature(other('How should the report be structured?')));
check('a different question does not', questionSignature(form('What should the report include?')) !== questionSignature(other('How should the report be structured?')));

// First ask: the operator's.
const per = new Map();
check('an unanswered question is shown', guardDecision(per, 'f1', 'Q').action === 'show');
check('a null history is shown', guardDecision(undefined, 'f1', 'Q').action === 'show');

// The operator answers: recorded with the answer.
per.set('Q', { answer: { 0: 'Deliverables + screenshot evidence' }, asks: 1 });

const second = guardDecision(per, 'f9', 'Q');
check('the second ask is answered automatically', second.action === 'auto', second.action);
check('it uses the operator\'s own answer', second.answer['0'] === 'Deliverables + screenshot evidence');
check('it counts as the second ask', second.asks === 2, String(second.asks));
// The caller records the ask (the decision is pure), exactly as guardQuestions does.
per.get('Q').asks = second.asks;

const third = guardDecision(per, 'f10', 'Q');
check('the third ask stops the run', third.action === 'stop', third.action);
check('the third ask still carries the answer', third.answer['0'] === 'Deliverables + screenshot evidence');
check('the third ask counts as three', third.asks === 3, String(third.asks));

// A question never asked before is not a loop, even in a session with history.
check('a new question in the same session is shown', guardDecision(per, 'f11', 'a different question').action === 'show');

check(
  'the answer reads as a sentence for the report',
  readableAnswer({ 0: 'Minimal pass/fail only' }) === '0: Minimal pass/fail only',
  readableAnswer({ 0: 'x' }),
);
check('an empty answer still reads', readableAnswer({}) === '(no answer recorded)');

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
