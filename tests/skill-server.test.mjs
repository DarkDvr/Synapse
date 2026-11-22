// The project-scoped skill server: it lists and reads only the project's own skills,
// installs/removes inside that project, and never sees the shipped library or another
// project. A real MCP process is spawned for the isolation, not a mocked function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECTS_ROOT } from '../src/paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'mcp', 'skill-server.js');

function mkProject() {
  const dir = fs.mkdtempSync(path.join(PROJECTS_ROOT, '.skill-test-'));
  fs.mkdirSync(path.join(dir, '.project', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.project', 'scratch'), { recursive: true });
  return dir;
}

function skillMarkdown(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

function call(child, method, params = {}) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15000);
    const onData = (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(msg);
        return;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function start(cwd) {
  return spawn(process.execPath, [SERVER], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const done = () => resolve();
    child.once('close', done);
    try { child.kill(); } catch { done(); }
    setTimeout(done, 3000);
  });
}

const textOf = (msg) => msg?.result?.content?.[0]?.text || '';

test('project skills stay in the project, and only there', async () => {
  const project = mkProject();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-skill-outside-'));
  const child = start(project);
  try {
    await call(child, 'initialize', { protocolVersion: '2024-11-05' });
    const tools = await call(child, 'tools/list');
    const names = (tools.result?.tools || []).map((t) => t.name);
    assert.deepEqual(names, ['skills_list', 'skills_use', 'skills_find', 'skills_install', 'skills_update', 'skills_remove']);

    fs.mkdirSync(path.join(project, '.project', 'skills', 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(project, '.project', 'skills', 'alpha', 'SKILL.md'), skillMarkdown('alpha', 'Alpha skill', 'Use alpha.'));
    fs.mkdirSync(path.join(project, '.skills', 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(project, '.skills', 'legacy', 'SKILL.md'), skillMarkdown('legacy', 'Legacy skill', 'Use legacy.'));

    const listed = await call(child, 'tools/call', { name: 'skills_list', arguments: {} });
    assert.match(textOf(listed), /alpha/);
    assert.match(textOf(listed), /legacy/);
    assert.doesNotMatch(textOf(listed), /visual-review/, 'the shipped library is not in a project list');

    const used = await call(child, 'tools/call', { name: 'skills_use', arguments: { name: 'alpha' } });
    assert.match(textOf(used), /Use alpha\./);

    // Install from a folder inside the project.
    const source = path.join(project, '.project', 'scratch', 'beta');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), skillMarkdown('beta', 'Beta skill', 'Use beta.'));
    fs.writeFileSync(path.join(source, 'notes.txt'), 'beta notes');
    const installed = await call(child, 'tools/call', { name: 'skills_install', arguments: { source: '.project/scratch/beta' } });
    assert.match(textOf(installed), /Installed "beta"/);
    assert.match(textOf(installed), /\.project\/skills\/beta/);
    assert.ok(fs.existsSync(path.join(project, '.project', 'skills', 'beta', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(project, '.project', 'skills', 'beta', 'SOURCE.md')));
    assert.ok(fs.existsSync(path.join(project, '.project', 'skills', 'beta', 'notes.txt')), 'the whole skill folder travels');

    // Update keeps the previous copy and takes the current source.
    fs.writeFileSync(path.join(source, 'SKILL.md'), skillMarkdown('beta', 'Beta skill v2', 'Use beta v2.'));
    const updated = await call(child, 'tools/call', { name: 'skills_update', arguments: { name: 'beta' } });
    assert.match(textOf(updated), /Updated "beta"/);
    assert.match(fs.readFileSync(path.join(project, '.project', 'skills', 'beta', 'SKILL.md'), 'utf8'), /beta v2/);
    assert.ok(fs.existsSync(path.join(project, '.project', 'skills', 'beta.bak', 'SKILL.md')), 'the previous copy is kept');

    const removed = await call(child, 'tools/call', { name: 'skills_remove', arguments: { name: 'beta' } });
    assert.match(textOf(removed), /Removed "beta"/);
    assert.ok(!fs.existsSync(path.join(project, '.project', 'skills', 'beta')));

    // A source outside the project is refused; a name with a path is refused.
    const escape = await call(child, 'tools/call', { name: 'skills_install', arguments: { source: '../outside' } });
    assert.match(textOf(escape), /inside this project/);
    const bad = await call(child, 'tools/call', { name: 'skills_use', arguments: { name: '../alpha' } });
    assert.match(textOf(bad), /not a usable skill name/);

    // Another project's folder is not visible from this one even when it has a skill.
    const other = path.join(PROJECTS_ROOT, '.skill-test-other');
    fs.mkdirSync(path.join(other, '.project', 'skills', 'other'), { recursive: true });
    fs.writeFileSync(path.join(other, '.project', 'skills', 'other', 'SKILL.md'), skillMarkdown('other', 'Other', 'Other.'));
    const still = await call(child, 'tools/call', { name: 'skills_list', arguments: {} });
    assert.doesNotMatch(textOf(still), /other/);
    fs.rmSync(other, { recursive: true, force: true });

    // Outside the projects root the server refuses to guess a project.
    const away = start(outside);
    try {
      await call(away, 'initialize', { protocolVersion: '2024-11-05' });
      const refused = await call(away, 'tools/call', { name: 'skills_list', arguments: {} });
      assert.match(textOf(refused), /not in a project/);
    } finally {
      await stop(away);
    }
  } finally {
    await stop(child);
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
