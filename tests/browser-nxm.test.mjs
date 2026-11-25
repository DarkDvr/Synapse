// nxm:// is not a page: it is a hand-off to the program Windows registered for it.
//
// Nexus's "Slow Download" can arrive as an anchor, a window.open call, or a
// navigation. WebView2 does not reliably raise a navigation event for a custom
// scheme, so the host also injects a click listener and patches window.open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

test('SynaBrowse hands only nxm to the operating system', () => {
  const host = read('shell/SynaBrowseHost/HostWindow.xaml.cs');
  assert.match(host, /private bool TryExternal\(string uri\)/);
  assert.match(host, /parsed\.Scheme, "nxm"/i, 'the scheme check is missing');
  assert.match(host, /ProcessStartInfo \{ FileName = uri, UseShellExecute = true \}/, 'the handler is not launched');
  assert.match(host, /_lastExternalAt/, 'a redirect can arrive through two events and launch twice');
  assert.doesNotMatch(host, /scheme, "https?/i, 'the hand-off is not limited to nxm');
});

test('the click and window.open routes are caught in the page', () => {
  const host = read('shell/SynaBrowseHost/HostWindow.xaml.cs');
  assert.match(host, /AddScriptToExecuteOnDocumentCreatedAsync\(NxmClickScript\)/);
  assert.match(host, /closest\('a\[href\]'\)/, 'anchor clicks are not seen');
  assert.match(host, /window\.open = function/, 'window.open is not patched');
  assert.match(host, /postMessage\(\{ synapse: 'nxm', uri:/, 'the page has no bridge to the host');
  assert.match(host, /OnWebMessageReceived/, 'the host does not read the bridge');
});

test('the host keeps its navigation-event fallbacks', () => {
  const host = read('shell/SynaBrowseHost/HostWindow.xaml.cs');
  assert.match(host, /core\.NavigationStarting/);
  assert.match(host, /core\.LaunchingExternalUriScheme/);
  assert.match(host, /core\.NewWindowRequested/);
  assert.match(host, /AddWebResourceRequestedFilter\("nxm:\*"/, 'no resource-level catch');
  assert.match(host, /OnWebResourceRequested/, 'the resource catch is not wired');
});
