// A busy answer belongs to the chat that asked for it (14 Nov).
//
// The chime's predicate read `state.busyInfo` without asking which chat the answer was
// for. Clicking into a finished project while another had a live run kept that run's
// `busy: true` in hand for up to a poll, so `sessionWorking` said the finished chat was
// working; when the poll caught up, the end of that "work" sounded the finished-work
// chime for a project finished hours earlier. The open chat's answer carries its id, and
// a late answer for a chat that is no longer open is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { state } from '../web/state.js';
import { sessionWorking } from '../web/projects.js';

test('a busy answer belongs to the chat that asked for it', () => {
  state.sessionId = 'ses_finished';
  state.busySessions = new Set();
  state.busySince = new Map();
  state.projects = [];
  state.runs = [];
  state.busyInfo = { busy: true };
  state.busyInfoSession = 'ses_running';
  assert.equal(sessionWorking('ses_finished'), false, "another chat's lock is not this chat's work");
  state.busyInfoSession = 'ses_finished';
  assert.equal(sessionWorking('ses_finished'), true, 'its own lock still counts');
  state.busyInfo = null;
  state.busyInfoSession = null;
});
