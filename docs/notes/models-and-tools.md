# Models and tools

The catalog, the thinking-effort variants, what Synapse remembers about a model,
the probe, and how the engine itself is updated. Split out of `AGENTS.md`
verbatim; read it before touching model selection or `src/modelcache.js`.

## Tools and models

- **The toolset is per-model, per-agent, and even per-call.** One run reported
  `execute`, the next did not. Never hardcode an assumption about which tools
  exist — the probe asks the model and reports it.
- Observed toolset: `edit, glob, grep, question, read, shell, skill, subagent,
  webfetch, websearch, write, execute`. There is **no `list`** and **no
  `todowrite`**; asked for `list` the model used `read`, asked for `task` it
  used `subagent`.
- **`question` is the form mechanism, and the form is the interface.** The tool
  call blocks the session, and the engine raises a **form** for it:
  `GET /api/session/{id}/form` lists it, `POST .../form/{formId}/reply` with
  `{answer:{<key>: value}}` settles it, and the tool call then completes with the
  answers in its output. A form is a schema, not a question: fields are
  `string` (with `options` → a choice, `custom: true` → an escape hatch),
  `multiselect` (checkboxes), `boolean`, `number`/`integer`, `external`, with
  `required`, `hidden` and `when` (eq/neq on another key). Missing one stalls a
  session forever.
  **The global form list is location-scoped and will not show a project's form.**
  `GET /api/form` only lists forms in the engine's own location (the projects
  root), so a question asked in a project subfolder is invisible there — which is
  exactly why the first real question showed up as a raw JSON tool card while the
  session sat blocked. Ask the session, not the world: a session waiting on a
  form is a session `GET /api/session/active` reports as active, and the open
  session is asked for by name too (`GET /api/pending?session=<id>`).
  **Forms live in the engine's memory.** A Synapse restart restarts the engine,
  and every pending form dies with it: the transcript is left with a tool part
  stuck at `running` and the turn never resumes. Interrupt the session (Stop)
  before a restart if a question is open; a stranded part is the one visible
  symptom.
- **Tools are fast; models are slow.** Measured tool execution: file tools
  10–130ms, shell ~300ms, webfetch ~180–330ms, `execute` ~50ms. Turn times are
  3–80s because of model latency. Judge tools by their own `time.completed -
  time.created`, not by the turn.
- **The free tier throttles.** Under rapid requests the provider returns
  "OpenCode's free tier can only be used from within OpenCode." It is
  intermittent, not a ban. **Every test turn spends the operator's quota** —
  batch checks, and prefer a single turn that proves several things.
  Evenings are slower than days on this provider — the operator's observation,
  and the reason `data\provider-errors.log` exists: expect 10+ minute turns and
  rate limits that last up to half an hour. The harness waits those out now; a
  test that assumes a fast turn is a test that looks broken at 21:00.

### Context windows and thinking effort

`GET /api/model` reports `limit.context`, `limit.output` and `variants`; each
variant sets a `reasoningEffort`. Synapse surfaces all of it (`normalizeModel`)
and stores the operator's choice per role.

- **Omitting a variant is not "no effort".** The engine stores
  `variant:"default"`, which is not one of the advertised variants. Measured
  reasoning tokens on the same task: `low` 70, default 228, `max` 719 (r/opencode
  boundary test, Oct 2026).
- **The catalog is conservative.** DeepSeek V4.1 Flash Free advertises 200k
  context, but the backend serves **1,048,576** — boundary-tested: ~1.037M OK,
  ~1.107M HTTP 400. MiMo-V2.6-Flash and Big Pickle are still genuinely 200k, so
  **never raise a limit without testing that model**.
- Synapse writes overrides from `engine.opencode.modelLimits` (config file) into
  `providers.opencode.models.<id>.limit` in the isolated engine config on every
  boot. That changes only the engine's local budgeting ceiling; the provider's
  own limit still applies. Output limits were *not* tested — only context.

### The model cache (`data\model-cache.json`)

Models come and go; what we learned about one should outlive it leaving the
catalog. The picker is built from the engine's **live** catalog on every launch:
the cache only supplies what we learned about a model that is still there (its
toolset, its variants, its issues), and never adds an entry of its own — a model
that leaves the catalog disappears with it. `src/modelcache.js` is a small JSON store **keyed by the full
`provider/id` ref**, because the same model can exist in more than one category
— `opencode/deepseek-v4.1-flash-free` and a future `opencode-go/…` are different
entries with different backends, and local runtimes will be more. Each record
holds name, provider, context/output, variants (`{id, label}` — label is the
provider's own `reasoningEffort`), capabilities, `firstSeen`/`lastSeen` and the
discovered toolset. `engine.listModels()` is recorded on every boot and every
`GET /api/models`, so the file stays current for free.

- **Each model is asked at most N times, ever** (default 3). The first selection
  fires `POST /api/models/inspect`; the server answers from cache when a *valid*
  (non-empty) tool list exists, refuses to stack a duplicate run, and serialises
  runs one at a time (`inspectChain`). A completed run increments `timesAsked`
  even when the answer is empty — an empty answer is only eligible for a retry
  while `timesAsked < modelChecks.maxAsks` (Settings, 1–20). At the cap the
  model is `exhausted` and is never asked again. The count is per model, so the
  attempts spread across selections and restarts. Synapse re-asks on boot for
  any **role's** current model that is still missing a valid list. Settings has
  **Reset Ask Counters**, which zeroes every model's count (valid results are
  kept). Verified: seeded one model at 3 asks → `{started:false, exhausted:true}`;
  another at 1 ask → asked again on restart and locked in; reset returned 11 and
  left `timesAsked` at 0 everywhere.
- The discovery prompt asks the model to list its tools; `parseToolNames` takes
  the last dotted segment (`tools["opencode"].list_mcp_resources` →
  `list_mcp_resources`) then keeps `[a-z0-9_-]` (MCP names contain hyphens — an
  earlier parser dropped them and turned `synapse-search_websearch` into
  `synapsesearch_websearch`).
- When the check finishes, `model.probed` goes out over SSE and the picker/effort
  tooltips gain a `· N tools` suffix. The picker menu itself shows a source chip
  (`OPENCODE`, `OPENCODE GO`, later a local provider) so two entries with the
  same display name can never be confused.
- **A model can be marked, and only the operator unmarks it.** A provider refusal
  during a worker run (`outcome: "error"`) writes the provider's own sentence into
  the model's record (`issues: [{ at, kind, message }]`, newest first, de-duplicated
  by message) and broadcasts `kind: 'model'` so the picker re-reads the catalog
  without a reload. The picker row grows an orange **ISSUES** chip whose tooltip is
  the sentence and its date, the closed picker's border goes amber, and **clicking
  the chip clears it**: no turn, no question, nothing written to the plan and
  nothing said to any model — "UI-only, only me", in the operator's words. The mark
  survives a restart until it is cleared, which is the point: a retired model is
  still advertised by the catalog, so without this the picker shows a dead model as
  perfectly healthy (that is exactly what happened to `space-bunny-free`).
  **The record never becomes policy:** the badge does not block a selection and is
  never mentioned in a brief. Deliberately, because a model can come back and
  because the operator is the one who checks.
- **The probe marks a model that cannot drive tools, and clears its own mark.** A
  probe run counts its *real* failures — a case whose tool the model was never
  offered does not count (`offered === false`), since the case list asks about
  tools a model may simply not have — and **3 or more** writes a `kind: 'tools'`
  issue naming the tools. The threshold is 3 because a probe is one turn per case
  against a flaky free provider, and two could be an afternoon. A later probe with
  fewer than 3 clears that *kind* by itself (`clearIssueKind`), because a clean run
  is the same evidence pointing the other way; a `provider` mark is never cleared
  automatically — that one is the operator's.
- `GET /api/models/cache` exposes the raw store for debugging.

### Is there a newer engine? (`src/engine-update.js`)

The catalog ships inside the engine binary, so a stale model list is nearly
always a stale *engine*. The status block names the version running; a small
yellow **Update** chip beside Settings appears when a newer one is known, and it
opens the dialog. When nothing is known it is not there at all.

- **Two sources, because they fail differently.** OpenCode Desktop ships its own
  engine and updates itself, so its `resources\opencode-cli.version` is read
  locally at boot — instant, offline, and on this machine it is the signal that
  actually arrives. npm (`registry.npmjs.org/@opencode/cli`) is asked **only when
  the dialog opens or Check Again is pressed**: the app is offline by rule, and a
  check the operator asked for is not the app phoning home at boot. The answer is
  cached in `data\engine-update.json`, so the chip survives a restart with no
  network and `GET /api/engine/update` is free.
- **The npm answer replaces the cached one**, rather than merely raising it —
  otherwise a wrong cache is sticky for ever (seen while testing with a fake
  `9.9.9`: the online check could not heal it). The desktop's version is compared,
  not trusted, so it can still be ahead of npm.
- **Updating is stop → `npm install -g @opencode/cli@latest` → start**, and that
  order is not a preference: on Windows a running `.exe` cannot be replaced. The
  engine restarts **in-process** (`engine.stop()` / `engine.start()`), so the UI
  stays up and the browser tab survives; measured 9.4 s end to end on 2.1.0 →
  2.1.0, catalog re-read, sessions and their transcripts intact. A failed install
  still restarts the engine, because being down is worse than being old.
- **It refuses while work is in flight** — a live delegation, or any session
  `/api/session/active` reports (which includes one blocked on a question) —
  because the restart loses that turn. It also refuses an engine it did not
  install with npm (`packageRoot()` walks up from the binary to an
  `@opencode/cli` `package.json`), rather than installing a second engine
  somewhere else while Synapse keeps using the old one.
- **`npm` cannot be run with `execFile` on Windows**; the install goes through
  `cmd.exe /d /s /c npm …` with array arguments.
- Settings → Engine carries **Check for Updates** too, so the feature is reachable
  when the chip is hidden. The dialog is honest about what it does not know: npm
  publishes no release notes for this package, and it says so instead of inventing
  a changelog.

### The probe (`Run Tool Probe`)

Drives one turn per tool in a disposable scratch session
(`<projects root>\_probe`), records the tool's own execution time, and labels a
failure "not offered by this model" when the tool was never in its list.

- It **interrupts a timed-out case** before starting the next. Without that, the
  wedge is inherited and every later case fails too.
- **The scratch session is invisible.** Probe and model-check sessions live in
  `<projects root>\_probe`; the API filters that directory out of project/session
  lists, so they never appear in the rail, and `probe.sweep()` deletes any
  leftover at boot (a killed process cannot leave a ghost). They are real
  engine sessions behind the scenes, not fake turns.
- Results persist to `data\probe.json` so a restart does not blank the panel.
  The run still records **which model** it was against (captured after the toolset
  discovery turn — a fresh session reports no model before its first turn), but
  the panel no longer prints it: a probe is a question about the *tools*, and the
  model name above the table read as if the results were model-specific. The ref
  stays in `probe.json` for the case where a result looks impossible. The toolset
  list is **not** printed either — the per-case table underneath is the useful
  view.

---

## The tool census

Every finished turn is scanned once and its tool calls recorded (keyed by part
id, so re-reading a transcript never double-counts) into
`data\tool-stats.json`: per tool and per model — calls, failures, exit codes,
average execution time, and the last 20 error signatures. `GET /api/tools/stats`
serves it; the rail's **Tools in use** panel shows the live summary.

It describes *now*, not history, so it **clears itself on every boot**
(`tools.resetOnBoot`, on by default — untick *Clear the Tool Census on every
start* in Settings to keep it across restarts), and Settings has a **Clear Tool
Census** button for a mid-session reset (`POST /api/tools/reset`). Left to
accumulate it stops describing the current environment: after a few days of
testing it read 184 calls from sessions that no longer existed.
