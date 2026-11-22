// Project-scoped skills: a real MCP server, one per session, whose working directory is
// the project. It reads and writes only that project's own skill folders — never the
// shipped `skills/` and never another project — so two projects open at once cannot see
// each other's skills.
//
// The engine's own `skill` tool is global; this server is the project-scoped counterpart.
// stdout carries JSON-RPC and nothing else. All logging goes to stderr.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { PROJECTS_ROOT } from '../paths.js';
import { webSearch, formatResults } from '../search.js';

const PROTOCOL_VERSION = '2024-11-05';
const PROJECT_ROOT = path.resolve(process.cwd());
const IN_PROJECT = PROJECT_ROOT.toLowerCase().startsWith(`${path.resolve(PROJECTS_ROOT).toLowerCase()}${path.sep}`);
// The canonical place; `.skills` is the folder the operator's own project already used,
// so its skills keep working. Both are inside the project; nothing else is read.
const CANON = path.join(PROJECT_ROOT, '.project', 'skills');
const LEGACY = path.join(PROJECT_ROOT, '.skills');
const ROOTS = [CANON, LEGACY];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

const HELP = `Project skills only: this server reads and writes this project's .project/skills (and legacy .skills); it never reads Synapse's shipped skills or another project.
skills_list: the skills installed in this project.
skills_use {name}: load a project skill's SKILL.md.
skills_find {query}: web search for a skill; it does not install.
skills_install {source, name?}: copy a local folder (inside this project) or clone a git URL into .project/skills; SOURCE.md records where it came from.
skills_update {name}: reinstall from SOURCE.md; keeps a .bak.
skills_remove {name}: delete this project's copy.
For a project skill use skills_use, not the engine's skill tool. A skill installed here is available only in this project.`;

const TOOLS = [
  {
    name: 'skills_list',
    description: 'List the skills installed in this project (.project/skills, and legacy .skills).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'skills_use',
    description: "Read a project skill's SKILL.md. Use this for project skills; the engine's skill tool only knows global skills.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill name.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'skills_find',
    description: 'Search the web for a skill. It does not install anything; use skills_install on the source you choose.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What kind of skill to look for.' },
        limit: { type: 'integer', description: 'How many results (1-10, default 5).', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'skills_install',
    description: 'Install a project skill from a local folder inside this project or a git URL. Writes only inside this project; a SOURCE.md records where it came from.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'A folder inside the project, or a git URL.' },
        name: { type: 'string', description: 'Optional name; defaults to the SKILL.md name or the folder.' },
        replace: { type: 'boolean', description: 'Replace an installed skill of the same name (keeps a .bak).' },
      },
      required: ['source'],
      additionalProperties: false,
    },
  },
  {
    name: 'skills_update',
    description: "Reinstall a project skill from its SOURCE.md and keep the previous copy as a .bak.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill to update.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'skills_remove',
    description: "Delete this project's copy of a skill. It never touches a shipped or global skill.",
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill to remove.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const toolText = (id, text, isError = false) => result(id, { content: [{ type: 'text', text }], isError });

function inside(parent, child) {
  const base = path.resolve(parent);
  const target = path.resolve(child);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

function safeName(value) {
  const name = String(value || '').trim();
  if (!NAME.test(name) || name === '.' || name === '..') throw new Error(`"${name}" is not a usable skill name`);
  return name;
}

function parseSkill(text, fallback) {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(clean);
  const meta = {};
  if (front) {
    for (const line of front[1].split(/\r?\n/)) {
      const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  const body = (front ? clean.slice(front[0].length) : clean).trim();
  return { name: meta.name || fallback, description: meta.description || '', body };
}

function readSkillFile(dir, fallback) {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const parsed = parseSkill(fs.readFileSync(file, 'utf8'), fallback || path.basename(dir));
  return { ...parsed, dir, file };
}

function listSkills() {
  if (!IN_PROJECT) return [];
  const found = new Map();
  for (const root of ROOTS) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { /* no folder yet */ }
    for (const entry of entries) {
      if (!entry.isDirectory() || !NAME.test(entry.name) || entry.name.endsWith('.bak')) continue;
      const skill = readSkillFile(path.join(root, entry.name), entry.name);
      if (!skill) continue;
      if (!found.has(skill.name)) found.set(skill.name, skill);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function findSkill(name) {
  if (!IN_PROJECT) throw new Error('This session is not in a project; project skills are not available.');
  const wanted = safeName(name);
  const skill = listSkills().find((s) => s.name === wanted);
  if (!skill) {
    const known = listSkills().map((s) => s.name);
    throw new Error(known.length
      ? `No project skill "${wanted}". Installed: ${known.join(', ')}.`
      : `No project skill "${wanted}". This project has no skills installed; use skills_find then skills_install.`);
  }
  return skill;
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { windowsHide: true });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new Error(`git is not available: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} failed (${code}): ${err.trim().slice(0, 500)}`));
    });
  });
}

function findSkillRoot(dir) {
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* empty */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (fs.existsSync(path.join(child, 'SKILL.md'))) return child;
  }
  throw new Error('the source has no SKILL.md at its root or one folder down');
}

function readSource(dir) {
  const file = path.join(dir, 'SOURCE.md');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const m = /^source:\s*(.+)$/m.exec(text);
  return m ? m[1].trim() : null;
}

function lookForSkill(source) {
  const raw = String(source || '').trim();
  if (!raw) throw new Error('give a folder inside the project, or a git URL');
  if (/^https?:\/\//i.test(raw) || /^git@/i.test(raw)) {
    const temp = path.join(PROJECT_ROOT, '.project', 'scratch', `.skill-install-${Date.now()}`);
    fs.mkdirSync(temp, { recursive: true });
    try {
      return { remote: true, temp, sourceDir: null, label: raw };
    } catch (err) {
      try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* best effort */ }
      throw err;
    }
  }
  const dir = path.resolve(PROJECT_ROOT, raw);
  if (!inside(PROJECT_ROOT, dir)) throw new Error('the source must be inside this project');
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`no SKILL.md in ${raw}`);
  return { remote: false, temp: null, sourceDir: dir, label: path.relative(PROJECT_ROOT, dir).replace(/\\/g, '/') };
}

async function installSkill(source, nameArg, replace) {
  if (!IN_PROJECT) throw new Error('This session is not in a project; project skills are not available.');
  const look = lookForSkill(source);
  let sourceDir = look.sourceDir;
  try {
    if (look.remote) {
      await runGit(['clone', '--depth', '1', look.label, look.temp]);
      sourceDir = findSkillRoot(look.temp);
    }
    const md = fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8');
    const parsed = parseSkill(md, path.basename(sourceDir));
    const name = safeName(nameArg || parsed.name);
    if (path.resolve(sourceDir) === path.join(CANON, name) || path.resolve(sourceDir) === path.join(LEGACY, name)) {
      throw new Error('the source and the destination are the same folder');
    }
    const existing = [path.join(CANON, name), path.join(LEGACY, name)].find((p) => fs.existsSync(p));
    if (existing && !replace) throw new Error(`skill "${name}" already exists; use skills_update to replace it`);
    if (existing) {
      const backup = `${existing}.bak`;
      fs.rmSync(backup, { recursive: true, force: true });
      fs.cpSync(existing, backup, { recursive: true, force: true });
      fs.rmSync(existing, { recursive: true, force: true });
    }
    const dest = path.join(CANON, name);
    fs.mkdirSync(CANON, { recursive: true });
    fs.cpSync(sourceDir, dest, {
      recursive: true,
      force: true,
      filter: (p) => !/[\\/]\.git([\\/]|$)/.test(p) && !/[\\/]\.bak([\\/]|$)/.test(p) && !/[\\/]SOURCE\.md$/.test(p),
    });
    fs.writeFileSync(
      path.join(dest, 'SOURCE.md'),
      `source: ${look.label}\ninstalled: ${new Date().toISOString()}\n`,
      'utf8',
    );
    return { name, dest, source: look.label };
  } finally {
    if (look.temp) { try { fs.rmSync(look.temp, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'synapse-skills', version: '1.0.0' },
        instructions: HELP,
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      const name = String(params?.name || '');
      const args = params?.arguments || {};
      try {
        if (!IN_PROJECT) {
          return toolText(id, 'This session is not in a project, so there are no project skills. Start the work inside a project folder.', true);
        }
        if (name === 'skills_list') {
          const skills = listSkills();
          if (!skills.length) {
            return toolText(id, 'No project skills installed. Use skills_find to look for one, then skills_install.');
          }
          const lines = skills.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ''} (${path.relative(PROJECT_ROOT, s.dir).replace(/\\/g, '/')})`);
          return toolText(id, `Project skills:\n${lines.join('\n')}\n\nUse skills_use {name} to read one.`);
        }
        if (name === 'skills_use') {
          const skill = findSkill(args.name);
          return toolText(id, `# ${skill.name}\n${skill.description ? `${skill.description}\n\n` : ''}${skill.body}`);
        }
        if (name === 'skills_find') {
          const query = String(args.query || '').trim();
          if (!query) return toolText(id, 'Give a query to search for.', true);
          const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
          const found = await webSearch(query, { limit });
          return toolText(id, `Search results (not installed):\n\n${formatResults(found)}\n\nInstall one with skills_install {source}, using a local folder inside this project or its git URL.`);
        }
        if (name === 'skills_install') {
          const done = await installSkill(args.source, args.name, Boolean(args.replace));
          return toolText(id, `Installed "${done.name}" into ${path.relative(PROJECT_ROOT, done.dest).replace(/\\/g, '/')} (source: ${done.source}).\n\nUse skills_use {name: "${done.name}"} to read it. This skill is available only in this project.`);
        }
        if (name === 'skills_update') {
          const skill = findSkill(args.name);
          const source = readSource(skill.dir);
          if (!source) return toolText(id, `"${skill.name}" has no SOURCE.md, so there is nothing to update from.`, true);
          const done = await installSkill(source, skill.name, true);
          return toolText(id, `Updated "${done.name}" from ${done.source}; the previous copy is at ${path.relative(PROJECT_ROOT, `${done.dest}.bak`).replace(/\\/g, '/')}.`);
        }
        if (name === 'skills_remove') {
          const skill = findSkill(args.name);
          fs.rmSync(skill.dir, { recursive: true, force: true });
          process.stderr.write(`removed project skill ${skill.name} at ${skill.dir}\n`);
          return toolText(id, `Removed "${skill.name}" from this project. Nothing outside this project was touched.`);
        }
        return toolText(id, `Unknown tool: ${name}`, true);
      } catch (err) {
        process.stderr.write(`skills ${name} failed: ${err.message}\n`);
        return toolText(id, err.message, true);
      }
    }
    default:
      return undefined;
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch {
    // A non-JSON line is not a request; the stream carries only JSON-RPC.
    return;
  }
  Promise.resolve(handle(msg)).catch((err) => {
    process.stderr.write(`skills protocol error: ${err.message}\n`);
  });
});
process.stderr.write(`synapse-skills MCP ready (${IN_PROJECT ? path.basename(PROJECT_ROOT) : 'not in a project'})\n`);
