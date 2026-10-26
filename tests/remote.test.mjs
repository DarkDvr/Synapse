// Remote access: only a private LAN address with the token may open the host's
// Synapse. The token is a password for the PC, so these checks are tested on
// their own before anything binds a port.
//
// Run: node tests\remote.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isLoopback, isPrivateAddress, parseCookies, tokenMatches, createRemoteToken, loginPage } from '../src/remote.js';

test('loopback is only this machine', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.50.10'), false);
  assert.equal(isLoopback('8.8.8.8'), false);
});

test('private addresses are the RFC1918 ranges, not the internet', () => {
  for (const address of ['192.168.0.1', '192.168.50.10', '10.0.0.5', '172.16.4.2', '172.31.255.254']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '11.0.0.1', '192.169.1.1', '127.0.0.1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('cookies are parsed without losing the token', () => {
  const cookies = parseCookies('a=1; synapse_remote=abc123; theme=dark');
  assert.equal(cookies.synapse_remote, 'abc123');
  assert.equal(cookies.theme, 'dark');
});

test('the token compare is exact', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('abc', 'abcd'), false);
  assert.equal(tokenMatches('', 'abc'), false);
});

test('a token is generated once and then read back from disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-remote-'));
  const file = path.join(dir, 'remote-token');
  const first = createRemoteToken({ file });
  const second = createRemoteToken({ file });
  assert.equal(first.length, 64);
  assert.equal(first, second);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), first);
});

test('the login page never embeds the token', () => {
  const html = loginPage({ error: 'nope' });
  assert.match(html, /Access token/);
  assert.match(html, /nope/);
  assert.doesNotMatch(html, /synapse_remote/);
});
