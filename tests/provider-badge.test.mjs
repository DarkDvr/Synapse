// The badge beside a provider's models is how the operator tells two local
// servers apart. It is the chosen model prefix for a local provider, and the
// provider's own name for a vendor.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { providerBadge } from '../web/settings-data.js';

test('a local provider wears its model prefix, not the word Local', () => {
  assert.equal(providerBadge({ id: 'glia', name: 'Glia', type: 'openai', baseURL: 'http://127.0.0.1:8080/v1' }), 'glia');
  assert.equal(providerBadge({ id: 'bionic', name: 'Bionic', type: 'local', baseURL: 'http://localhost:1235/v1' }), 'bionic');
  // A prefix of "local" adds nothing to the word Local, so the name stands in.
  assert.equal(providerBadge({ id: 'local', name: 'Glia', type: 'local', baseURL: 'http://localhost:1234/v1' }), 'Glia');
  // The default name is not repeated in the badge before it is renamed.
  assert.equal(providerBadge({ id: '', name: 'Local Server', type: 'local', baseURL: '' }), 'Local');
  assert.equal(providerBadge({ id: 'local-server', name: 'Local Server', type: 'local', baseURL: '' }), 'Local');
});

test('a vendor keeps its display name', () => {
  assert.equal(providerBadge({ id: 'deepseek', name: 'DeepSeek', type: 'openai', baseURL: 'https://api.deepseek.com/v1' }), 'DeepSeek');
  assert.equal(providerBadge({ id: 'oc-go', name: 'OpenCode Go', type: 'openai', baseURL: 'https://opencode.ai/zen/go/v1' }), 'OpenCode Go');
});
