// A provider's error inside a working response is a failed turn, not an outage (15 Nov).
//
// The charmap failure arrived as HTTP 200 with `{"error": {"type": "server_error", …}}`
// in the body — after the stream's status line, so there is no status left to say it.
// The engine relays it as a provider error with `response.body`; the runner used to read
// the sentence alone, classify it "unknown" and retry, which turned one provider bug into
// ten identical failures. The shape is recognised here so it is reported once, as the
// provider's own sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { providerErrorFrame, normalizeMessage } from '../src/engines/base.js';
import { classifyFailure } from '../src/provider-errors.js';

const frameError = {
  type: 'provider.internal',
  message: "'charmap' codec can't encode character '\\u2713' in position 41: character maps to <undefined>",
  status: 200,
  response: {
    body: JSON.stringify({
      error: {
        type: 'server_error',
        message: "'charmap' codec can't encode character '\\u2713' in position 41: character maps to <undefined>",
      },
    }),
  },
};

test('an error object inside a 200 response is recognised as the provider\'s', () => {
  const frame = providerErrorFrame(frameError);
  assert.equal(frame?.type, 'server_error');
  assert.match(frame.message, /charmap/);
  // The message is the provider's own sentence, and the kind says where it came from.
  const message = normalizeMessage({ id: 'm1', type: 'assistant', error: frameError });
  assert.equal(message.errorKind, 'provider-frame');
  assert.match(message.error, /charmap/);
});

test('an ordinary failure is not a provider frame', () => {
  assert.equal(providerErrorFrame({ type: 'aborted', message: 'Step interrupted' }), null);
  assert.equal(providerErrorFrame({ type: 'provider.error', message: 'rate limited', status: 429 }), null);
  assert.equal(providerErrorFrame({ message: 'x', response: { body: 'not json' } }), null);
  const message = normalizeMessage({ id: 'm2', type: 'assistant', error: { type: 'aborted', message: 'Step interrupted' } });
  assert.equal(message.errorKind, null);
});

test('a provider frame is terminal, so the same request is not retried', () => {
  const cls = classifyFailure(`the provider returned an error inside its response: ${frameError.message}`);
  assert.equal(cls.kind, 'terminal');
  assert.equal(cls.reason, 'provider-frame');
  // The rest of the ladder is untouched: a rate limit is still worth waiting out.
  assert.equal(classifyFailure('rate limit reached, try again in 20s').kind, 'transient');
});
