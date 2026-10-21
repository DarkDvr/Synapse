// Tool-call probe.
//
// We cannot guess which tools these models reach for, how often they get them
// wrong, or how slow they are. So we ask directly: a fixed list of cases, one
// per tool in the engine's real toolset, each written to force exactly that
// tool. Every case runs in a scratch session, and the resulting tool parts are
// read back out of the transcript — name, ok/failed, exit code, duration.
//
// The case list is the toolset the model itself reports:
//   edit, glob, grep, question, read, shell, skill, subagent, webfetch,
//   websearch, write, execute
// An earlier revision of this file guessed `list`, `todowrite` and `task`;
// the probe proved none of those exist here and the model used `read` and
// `subagent` instead. That is the point of running it.
//
// The run also feeds the census for free, because the census scans every
// finished turn. Results here are the per-case view; the census is the
// per-tool aggregate.
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CASE_TIMEOUT_MS = 150000;
const POLL_MS = 1200;

// How many *real* case failures earn a model the tool badge. Three, not two: a
// probe is one turn per case against a flaky free provider, so two could be an
// afternoon. A tool the model was never offered never counts (see `offered`).
const PROBE_FAILURES_TO_MARK = 3;

// Each prompt is deliberately blunt: it names the tool and the exact argument.
// A model that ignores it tells us something too — the case reports "missing".
export const PROBE_CASES = [
  {
    id: 'shell-ok',
    tool: 'shell',
    prompt: 'Use the shell tool. Run exactly this command and nothing else: echo probe-shell-ok',
  },
  {
    id: 'shell-fail',
    tool: 'shell',
    prompt: 'Use the shell tool. Run exactly this command and nothing else: probe-no-such-command-xyz',
  },
  {
    id: 'write',
    tool: 'write',
    prompt: 'Use the write tool to create a file named probe.txt in the current directory containing exactly: hello probe',
  },
  {
    id: 'read',
    tool: 'read',
    prompt: 'Use the read tool to read the file probe.txt in the current directory.',
  },
  {
    id: 'edit',
    tool: 'edit',
    prompt: 'Use the edit tool to replace the word hello with the word goodbye in probe.txt.',
  },
  {
    id: 'glob',
    tool: 'glob',
    prompt: 'Use the glob tool with the pattern **/*.txt to find text files in this directory.',
  },
  {
    id: 'grep',
    tool: 'grep',
    prompt: 'Use the grep tool to search this directory for the word goodbye.',
  },
  {
    // `question` blocks the session on a form until it is answered, so the
    // runner auto-answers it. That exercises the form path at the same time.
    id: 'question',
    tool: 'question',
    prompt: 'Use the question tool to ask me which of these I prefer: "option a" or "option b".',
  },
  {
    id: 'webfetch-ok',
    tool: 'webfetch',
    prompt: 'Use the webfetch tool to fetch https://example.com and report its title.',
  },
  {
    id: 'webfetch-bad',
    tool: 'webfetch',
    prompt: 'Use the webfetch tool to fetch https://probe-host-does-not-exist.invalid and report what happens.',
  },
  {
    id: 'websearch',
    tool: 'websearch',
    prompt: 'Use the websearch tool to search for the phrase "example domain" and report the first result.',
  },
  {
    id: 'subagent',
    tool: 'subagent',
    prompt: 'Use the subagent tool to launch a subagent that reports the absolute path of the current working directory.',
  },
  {
    id: 'execute',
    tool: 'execute',
    prompt: 'Use the execute tool to run this JavaScript and report the result: return 6 * 7;',
  },
  {
    id: 'skill',
    tool: 'skill',
    prompt: 'Use the skill tool to list the skills that are available to you.',
  },
];

/** A sensible answer for whatever the agent asked, so the probe never stalls. */
function defaultAnswer(fields) {
  const answer = {};
  for (const f of fields || []) {
    const key = f.key;
    const opts = Array.isArray(f.options) ? f.options : [];
    if (f.type === 'boolean') answer[key] = true;
    else if (f.type === 'multiselect') answer[key] = opts.length ? [opts[0].value] : [];
    else if (opts.length) answer[key] = opts[0].value;
    else if (f.type === 'number' || f.type === 'integer') answer[key] = 1;
    else answer[key] = 'probe';
  }
  return answer;
}

/** Pull tool names out of a model's comma/newline-separated answer. */
export function parseToolNames(text) {
  return [
    ...new Set(
      String(text || '')
        .split(/[,\n]/)
        // Answers are free text: `tools["opencode"].list_mcp_resources`,
        // `opencode.models`, plain `edit`. Keep the last dotted segment (the
        // tool name), then only name-safe characters. Hyphens are part of real
        // names — MCP namespaces use them.
        .map((t) => t.split(/[."'[\]]/).filter(Boolean).pop() || '')
        .map((t) => t.replace(/[^a-z0-9_-]/gi, '').toLowerCase())
        .filter((t) => t.length > 1 && t.length < 32),
    ),
  ];
}

/**
 * Ask one model what tools it has, in its own throwaway session, and return the
 * names it reports. Used by the model cache when a model is first selected —
 * once per model, not once per run. Returns [] on failure or an empty answer,
 * and the caller then leaves the record unmarked so a later attempt can retry.
 */
export async function discoverToolsetForModel(engine, log, model, directory) {
  // A session cannot run in a directory that does not exist — the engine answers
  // LocationNotFoundError on the prompt, which reads as "the model refused" and
  // left every model unmarked. The folder is ours; make sure it is there.
  try { fs.mkdirSync(directory, { recursive: true }); } catch { /* the prompt will say so */ }
  const session = await engine.createSession({ title: 'Model check', model, directory });
  try {
    await engine.prompt(
      session.id,
      'List the exact names of every tool available to you, separated by commas. ' +
        'Output only the tool names, nothing else. Do not call any tool.',
    );
    const deadline = Date.now() + 90000;
    let messages = [];
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      messages = await engine.getMessages(session.id);
      if (messages.length && messages[messages.length - 1]?.type === 'idle') break;
    }
    const text = messages
      .filter((m) => m.type === 'assistant')
      .map((m) => m.text || '')
      .join(' ');
    const names = parseToolNames(text);
    log.info(`model check ${model}: reported [${names.join(', ') || 'nothing'}]`);
    return names;
  } finally {
    try { await engine.deleteSession(session.id); } catch { /* already gone */ }
  }
}

export function createProbe({ engine, logger, notify, scratchDir, file, modelCache }) {  const log = logger.channel('tools');
  let state = {
    running: false,
    startedAt: null,
    finishedAt: null,
    current: null,
    results: [],
    toolset: [],
    // which model the last run was against; the toolset is per model
    model: null,
  };

  // The last run outlives the process, so the panel is not blank after a
  // restart — a full run costs minutes.
  try {
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
      if (saved && Array.isArray(saved.results) && saved.results.length) {
        state.finishedAt = saved.finishedAt || null;
        state.results = saved.results;
        state.toolset = Array.isArray(saved.toolset) ? saved.toolset : [];
        state.model = saved.model || null;
        log.info(`probe results restored: ${state.results.length} cases from an earlier run`);
      }
    }
  } catch (err) {
    log.warn(`probe results could not be restored (${err.message})`);
  }

  function persist() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        `${JSON.stringify({ finishedAt: state.finishedAt, model: state.model, toolset: state.toolset, results: state.results }, null, 2)}\n`,
        'utf8',
      );
      fs.renameSync(tmp, file);
    } catch (err) {
      log.warn(`probe results could not be saved: ${err.message}`);
    }
  }

  async function toolParts(sessionId) {
    const messages = await engine.getMessages(sessionId);
    const parts = [];
    for (const m of messages) for (const p of m.parts || []) if (p?.type === 'tool') parts.push(p);
    return parts;
  }

  /**
   * The toolset is not fixed — it depends on the model and the agent, so a case
   * can fail simply because this model was never offered that tool. Ask the
   * model what it has, once per run, and use it to label the results honestly.
   * The answer is a hint, never a gate: we still run every case.
   */
  async function discoverToolset(sessionId) {
    const before = (await engine.getMessages(sessionId)).length;
    try {
      await engine.prompt(
        sessionId,
        'List the exact names of every tool available to you, separated by commas. ' +
          'Output only the tool names, nothing else. Do not call any tool.',
      );
      const deadline = Date.now() + 90000;
      let messages = [];
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        messages = await engine.getMessages(sessionId);
        if (messages.length > before && messages[messages.length - 1]?.type === 'idle') break;
      }
      const text = messages
        .filter((m) => m.type === 'assistant')
        .map((m) => m.text || '')
        .join(' ');
      const names = parseToolNames(text);
      log.info(`probe: this model offers [${names.join(', ') || 'nothing reported'}]`);
      return names;
    } catch (err) {
      log.warn(`probe: toolset discovery failed: ${err.message}`);
      return [];
    }
  }

  async function runOne(sessionId, c) {
    const beforeMessages = await engine.getMessages(sessionId);
    const beforeCount = beforeMessages.length;
    const seen = new Set((await toolParts(sessionId)).map((p) => p.id));

    state.current = c.id;
    notify({ kind: 'probe', type: 'probe.case.started', case: c.id, tool: c.tool });

    const t0 = Date.now();
    await engine.prompt(sessionId, c.prompt);

    // The engine closes every turn by appending an `idle` message, so that is
    // the end-of-turn signal — no guessing from timers. While we wait, answer
    // any form the agent raises, otherwise a `question` case would hang here.
    let messages = beforeMessages;
    const deadline = t0 + CASE_TIMEOUT_MS;
    let closed = false;
    let formsAnswered = 0;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      try {
        const forms = await engine.listForms(sessionId);
        for (const f of forms) {
          const answer = defaultAnswer(f.fields);
          await engine.replyForm(sessionId, f.id, answer);
          formsAnswered += 1;
          log.info(`probe ${c.id}: auto-answered form ${f.id}`);
        }
      } catch { /* no form support, or the form vanished */ }
      messages = await engine.getMessages(sessionId);
      if (messages.length > beforeCount && messages[messages.length - 1]?.type === 'idle') {
        closed = true;
        break;
      }
    }
    const ms = Date.now() - t0;

    // A case that never closed leaves the session running. If we just move on,
    // the *next* case inherits the wedge and times out too — which is exactly
    // what happened on the first run. Interrupt and let it settle.
    if (!closed) {
      log.warn(`probe ${c.id}: no end-of-turn after ${ms}ms; interrupting`);
      try {
        await engine.interrupt(sessionId);
        await sleep(4000);
      } catch (err) {
        log.warn(`probe ${c.id}: interrupt failed: ${err.message}`);
      }
    }

    const fresh = (await toolParts(sessionId)).filter((p) => !seen.has(p.id));
    const used = [...new Set(fresh.map((p) => p.name))];
    const failed = fresh.filter((p) => p.failed);
    // MCP tools arrive namespaced (`synapse-search_websearch`), so a plain name
    // match is too strict.
    const matches = (n, want) => n === want || n.endsWith(`_${want}`) || n.endsWith(`/${want}`);
    const expected = used.some((n) => matches(n, c.tool));
    // The tool's own execution time, which is what "how fast" should mean —
    // the turn time is mostly the model thinking.
    const toolMs = fresh.reduce((sum, p) => sum + (typeof p.ms === 'number' ? p.ms : 0), 0);
    // null when the model did not report a toolset at all.
    const offered = state.toolset.length ? state.toolset.some((n) => matches(n, c.tool)) : null;

    const result = {
      id: c.id,
      expect: c.tool,
      ms,
      toolMs,
      calls: fresh.length,
      used,
      formsAnswered,
      offered,
      // "ok" means: the turn closed, the tool we asked for actually ran, and
      // none of the calls in the turn failed.
      ok: closed && fresh.length > 0 && expected && failed.length === 0,
      timedOut: !closed,
      missing: fresh.length === 0,
      wrongTool: fresh.length > 0 && !expected,
      durations: fresh.map((p) => ({ tool: p.name, ms: p.ms })),
      errors: failed.map((p) => ({
        tool: p.name,
        exitCode: p.exitCode ?? null,
        detail: String(p.error || p.output || '').replace(/\s+/g, ' ').slice(0, 300),
      })),
      finishedAt: Date.now(),
    };

    log.info(
      `probe ${c.id}: ran=[${used.join(',') || 'none'}] calls=${fresh.length} turn=${ms}ms tool=${toolMs}ms ` +
        `ok=${result.ok}${formsAnswered ? ` forms=${formsAnswered}` : ''}${result.timedOut ? ' TIMEOUT' : ''}`,
    );
    notify({ kind: 'probe', type: 'probe.case.finished', result });
    return result;
  }

  /**
   * Remove probe scaffolding from earlier runs so only one can ever exist.
   * Matches by directory, not title: the scratch dir is Synapse's, so any
   * session there is disposable — including a model-check session left behind
   * by a killed process.
   */
  async function sweep() {
    const key = (d) => String(d || '').replace(/[\\/]+$/, '').toLowerCase();
    try {
      const sessions = await engine.listSessions();
      for (const s of sessions) {
        if (key(s.directory) === key(scratchDir)) {
          try { await engine.deleteSession(s.id); } catch { /* already gone */ }
        }
      }
    } catch { /* engine not ready */ }
  }

  async function run() {
    if (state.running) return { started: false, reason: 'A probe is already running.' };
    state = { running: true, startedAt: Date.now(), finishedAt: null, current: null, results: [], toolset: [], model: null };
    notify({ kind: 'probe', type: 'probe.started', total: PROBE_CASES.length });

    fs.mkdirSync(scratchDir, { recursive: true });
    await sweep();

    let session = null;
    try {
      session = await engine.createSession({ title: 'Tool Probe', directory: scratchDir });
      // Which tools this model was actually given comes first: it decides how
      // the results should be read.
      state.current = 'toolset';
      notify({ kind: 'probe', type: 'probe.case.started', case: 'toolset', tool: 'discovery' });
      state.toolset = await discoverToolset(session.id);
      // Name the model only after that first turn: a session created without an
      // explicit model reports none until it has run. If it still reports none,
      // fall back to the engine's default model — that is what is actually
      // serving this run.
      try {
        const info = await engine.getSession(session.id);
        let ref = info?.model || null;
        let variant = info?.variant || null;
        if (!ref) {
          const def = await engine.getDefaultModel?.();
          ref = def?.ref || null;
          variant = null;
        }
        state.model = ref ? `${ref}${variant && variant !== 'default' ? `#${variant}` : ''}` : null;
        // The cache is keyed by the bare ref, never by ref#variant.
        state.modelRef = ref || null;
      } catch { state.model = null; state.modelRef = null; }
      notify({ kind: 'probe', type: 'probe.toolset', toolset: state.toolset, model: state.model });
      for (const c of PROBE_CASES) {
        try {
          state.results.push(await runOne(session.id, c));
        } catch (err) {
          log.warn(`probe ${c.id} threw: ${err.message}`);
          const failed = {
            id: c.id, expect: c.tool, ok: false, calls: 0, used: [],
            ms: null, toolMs: null, error: err.message, finishedAt: Date.now(),
          };
          state.results.push(failed);
          notify({ kind: 'probe', type: 'probe.case.finished', result: failed });
        }
      }
    } catch (err) {
      log.error(`probe run failed: ${err.message}`);
      notify({ kind: 'probe', type: 'probe.failed', error: err.message });
    } finally {
      // The scratch session is scaffolding; the census already has the calls.
      if (session) { try { await engine.deleteSession(session.id); } catch { /* gone */ } }
      state.running = false;
      state.current = null;
      state.finishedAt = Date.now();
      persist();
      const passed = state.results.filter((r) => r.ok).length;
      log.info(`probe finished: ${passed}/${state.results.length} cases clean`);
      // A model that cannot drive a few tools will waste worker turns, so the
      // probe is the honest source for the *tool* half of the badge of shame.
      // Only real failures count: a tool the model was never offered is not a
      // fault (`offered === false`), because the case list asks about tools this
      // model may simply not have.
      const bad = state.results.filter((r) => !r.ok && r.offered !== false);
      if (modelCache && state.modelRef) {
        try {
          if (bad.length >= PROBE_FAILURES_TO_MARK) {
            const names = bad.slice(0, 6).map((r) => r.expect || r.id);
            const marked = modelCache.noteIssue(state.modelRef, {
              kind: 'tools',
              message:
                `Probe: ${bad.length} of ${state.results.length} cases failed ` +
                `(${names.join(', ')}${bad.length > names.length ? ', …' : ''})`,
            });
            if (marked) notify({ kind: 'model', type: 'issues', ref: state.modelRef });
          } else if (modelCache.clearIssueKind(state.modelRef, 'tools')) {
            // A clean probe is the same evidence pointing the other way: the
            // operator does not have to clear this one.
            notify({ kind: 'model', type: 'issues', ref: state.modelRef });
          }
        } catch { /* the badge is not worth failing a probe over */ }
      }
      notify({ kind: 'probe', type: 'probe.finished', results: state.results });
    }
    return { started: true };
  }

  return { run, sweep, state: () => state, cases: PROBE_CASES };
}
