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
- **There is no such thing as "the" context window, so nothing may assume one.**
  Most hosted models here are 1,048,576; MiMo, Big Pickle and GLM are 200,000; a
  local LLM the operator plugs in later will be ~62,000. Even the *engine* does
  not compact at the model's limit: on the clock run it auto-compacted at 290k on
  a model advertising 1M. So compaction is not a schedule and not a token number.

**The window watchdog (`src/runs.js`).** The one thing Synapse can do about it is
a boundary check, and only from facts:

- `windowRoom({context, output})` = `context - output - max(8k, 5% of context)` —
  the room left for the next turn's own output and for what it will pull in.
- It fires when *that model's* recorded window is about to be reached, once, and
  re-arms only after the transcript has fallen below 70% of the room (a compaction
  that did not take must not become a request every poll).
- **A window nobody recorded gets no watchdog at all.** `modelCache.get(ref)` or
  the operator's `modelLimits` is the only source; guessing is how a 62k local
  model would be treated like a 1M hosted one.
- It runs inside `waitForIdle`, which already has the messages on every 1.5s poll,
  so it costs no extra engine call and can never slow a turn down. It watches the
  Architect too (its session outlives every delegation), using the session's own
  model rather than the card's.
- `POST /api/session/{id}/compact` is "durably admit a session compaction request
  … it runs at the next step boundary", so it is safe to send mid-run; a 409 means
  one is already queued. The transcript is kept; only what the model is sent is
  replaced by the summary.
- This is a *safeguard*, not a strategy. The failure it prevents is an oversized
  request, which is the one error a retry can never fix. Prevention — shorter
  tasks, batched tools — is the strategy.

**What the engine actually does, read out of its own bundle** (2.1.2, the
`@opencode/SessionCompaction` chunk). This is not documented anywhere and it
explains every "why did it compact *now*" question:

```
threshold = context − max(floor(context × 0.15), context ≥ 32,000 ? 16,000 : 0)
fires when   last step's (input + cache.read + cache.write + output + reasoning)
             + an estimate of the tool results that arrived since >= threshold
```

- So the reserve is **15% of the context, but never less than 16,000 tokens** — on
  a 42,240 window that is 16,000, and it compacts at **26,240**. On 60,160 it is
  still 16,000 → 44,160. On 1,048,576 it is 15% → 891,290.
- The count is not the provider's prompt size: it adds an *estimate* of the tool
  results waiting to be sent, which is why a run can compact at 19,981 one minute
  and 26,812 the next. Chasing a single "compaction size" is chasing a moving
  number.
- `compaction.buffer` replaces that whole `max(15%, 16k)` reserve when set.
  `compaction.auto` defaults to true; `keep` defaults to **15,000** tokens, which
  is why a compacted transcript comes back at ~11k and refills within a few turns.
- `output` plays no part in this: the reserve is a flat share of `context`, and
  `limit.output` only limits what the model may write.

**The number the engine compacts on is the number the *engine* was told** — the
catalog/provider-config copy, not what the runtime has loaded. Ours is the loaded
one. When the two differ the engine wins the race, because it is the thing that
compacts.

**The incident that proves it (22 Oct, t7 again).** A local model with 60,160
loaded and `limit.context: 42240` in the engine config: six compactions in
thirteen minutes, at prompt sizes of 19,981–26,812, every one of them
`"reason":"auto"`, and **not one** `compacting before the window closes` line in
`app.log` — the watchdog was waiting for 45,968, which the engine's 26,240 always
arrives first, so our safeguard never fired at all. The warning that would have
told us was logged at INFO on the `tools` channel, which is not mirrored to the
console: it read *"using 60160 for this run"*, and sounded like good news. It is
now a warning that names the number the engine will compact at.

**Where the number comes from, and which source wins.** Three answers can disagree,
and the rule is *measurement beats claim*:

1. **What a local server has loaded** (`providerLoadedWindow`) — asked once per run,
   per model. LM Studio answers `/api/v0/models` with `loaded_context_length`; a
   llama.cpp-family server answers `/props` with `n_ctx`; vLLM puts `max_model_len`
   in `/v1/models`. Only what is *loaded* counts: a model nobody loaded has no
   window.
2. **A prompt the provider refused.** This is the cloud equivalent, because a hosted
   model has no endpoint to ask. `classifyFailure` already labels it `kind:
   'context'`; the size of the refused prompt is recorded by
   `modelCache.noteContext()` and the next turn budgets *below* it. A catalog that
   later reports a different window clears the refusal, so the two cannot fight.
3. **The operator's `modelLimits` override.** A deliberate, boundary-tested
   number, not a claim — see "The override is a documented field" below.
4. **The claim**: the engine catalog's `limit.context`, which is where all these
   numbers came from in the first place.

That order is one function now, `resolveWindow()` in `src/runs.js`, because the
order *is* the rule and it needs to be readable and tested in one place:

| | beats | loses to |
|---|---|---|
| loaded | everything | nothing |
| override | refused, catalog | loaded |
| refused | a catalog larger than it | loaded, override |
| catalog | nothing | all three |

Loaded beats everything, which fixes the old `min(declared, loaded)`: that kept the
**smaller** number, so raising a local window from 42,240 to 60,160 (Bionic,
22 Oct) was silently ignored, and the warning only fired in the other direction.
Both directions are logged now.

**The override outranks a refusal on purpose.** A refusal is one provider's answer
on one afternoon; an override is a number the operator made that provider serve, by
hand, at the boundary. Before this, a single 200k refusal would have cancelled a
working 1M setting and the run would have started compacting at a fifth of its real
window — the Fever Tracker mistake again, with a different cause.

**Both spellings of the key are honoured.** The engine config takes the **bare**
model id (`providers.opencode.models.<id>.limit`), while a ref in Synapse is
`provider/model`. `modelLimits` may be written either way and `contextWindow()`
finds it either way; when only the ref was checked, the engine could be serving 1M
while the watchdog believed 200k.

**The override is a documented field, not a hack.** OpenCode's config schema
(`https://opencode.ai/config.json`, `ProviderConfig.models.*.limit`) defines
`limit {context, input, output}` per model — so `engine.opencode.modelLimits` writes
exactly where the format says a model's window is declared, and the engine's own
budgeting then uses it. The schema also documents `compaction`
(`auto`, `keep.tokens`, `buffer`; `reserved`/`prune`/`tail_turns` are deprecated),
which is the *other* lever on the 49-compaction problem — unproven here, do not
turn it without a run to show it helped.

**Asking the engine about limits.** The catalog Synapse stores
(`data\model-cache.json`) is `GET /api/model` → `{data:[{id, providerID, limit:
{context, output}, variants}]}`, re-read at boot and after an engine update; the
console line `catalog: N model(s) from engine X` is the check. The v2 server docs
list the provider-shaped routes instead — `GET /config` (the merged config, which
includes our own `limit` overrides), `GET /config/providers` and `GET /provider`
(`{all, default, connected}`) — so if `/api/model` ever disappears, those are
where a window can be read from.

**What that cost, on one run.** Fever Tracker's t7 ran 86 turns and 81 minutes, and
`logs\app.log` holds **32** lines of `context 30k of 42k … compacting before the
window closes` while the server had **60,160** loaded: the watchdog was compacting
against a window 18k too small, over and over (the run's own tally: 49 compactions).
Every one of those threw away the transcript the coder was working from. That is
the shape of the bug — not a wrong number, but a *silently* wrong number that the
harness acts on forty-nine times.

**The operator can see it while it runs**: the role card carries
`27k/60k ctx` beside the rate, and every compaction adds a pinned amber line to the
worker's trace (`⏳ Compacting ×2 · context at 32k/60k`), which is not a step and is
never trimmed out of the trace's four-line tail.

### Other model servers: a local LLM in the same dropdown

`engine.opencode.providers` in `config\synapse.config.json` registers any
OpenAI-compatible server — a local LLM, a second vendor — and it then appears in the
model menu like any other model:

```json
"providers": [
  { "id": "bionic", "name": "Bionic",
    "baseURL": "http://localhost:1235/v1", "apiKey": "",
    "models": [{ "id": "qwen3.8-27b-ud", "name": "Qwen 3.8 27B UD" }] }
]
```

`src/engines/opencode.js` writes each one into the engine's own config as`provider.<id>` with `npm: "@ai-sdk/openai-compatible"`, `options.baseURL` and a
`models` map — **`provider` singular for definitions, `providers` plural for
per-provider overrides**, and getting those two names the wrong way round is
silent. Nothing is contacted until a model is picked and a turn is run; an
unreachable server fails that turn and nothing else.

`context`/`output` are optional per model, and are the only honest source for the
window watchdog (`src/runs.js`). Left out, the engine reports **its own default
(200,000 for a provider it has no limit for)** — which is not the local model's real
window, so set it when you know it. Measured: `qwen3.8-27b-ud` on `localhost:1235`
answered a turn through the engine in **18 s**, no other change needed.

**Ask the server what its window really is, don't guess from the card.** LM Studio
answers `GET /api/v0/models` with `max_context_length` (what the model supports) and
`loaded_context_length` (what it actually reserved). Measured here: 262,144 and
**39,168** — a 27B at IQ3_S on a 16 GB card. Synapse was configured with 40,960,
1,792 tokens *larger than the window*, and the server's **Context Overflow:
Truncate Middle** would have silently dropped the middle of an oversized prompt
rather than failing — for an agent that means keeping the task at the top and the
last turn at the bottom while the file contents in between vanish. Set the limit to
the loaded length or below.

**What a 40k window costs.** The engine compacts at roughly the same point the
watchdog does (~60% of the window): a 32-turn task at 39k took **3 compactions**
and read 541k prompt tokens, peaking at 24.6k. That is workable for a small task and
would be constant churn for a big one — which is the argument for splitting tasks
rather than for a bigger window.

### A vendor's own API (DeepSeek, and any other)

**The way in is Settings > Providers**, not this file by hand: the tab lists the
engine's built-in catalog as a read-only row and every registered provider below
it, and offers *Local Provider* and *OpenAI Compatible* (the two ids differ only
by where they point — see `providerType()` in `src/providers.js`). `OpenCode` is
in the add menu but disabled: the engine's catalog is always registered, and a
second copy would be the same models twice. A row can be added, renamed, given a
server URL and a key, and *Refresh List* asks that server what it serves. Saving
writes the same `providers` array documented here, so a hand-written entry and a
clicked one are the same thing.

**A local server is one of two list formats.** `format: "openai"` (LM Studio,
vLLM, llama.cpp) answers `GET /models`; `format: "ollama"` answers
`GET /api/tags`, whose entries are `{name}` rather than `{id}`. Chat goes through
the OpenAI-compatible URL either way — Ollama serves that at `/v1`, which is why
the same provider definition works for both — so `format` only decides which list
endpoint `Refresh List` asks *first*: `src/providers.js` tries the other one
automatically (a 404 at `/models` falls through to `/api/tags`, and a refused
connection stops after one attempt).

**Ask the runtime what window it reserved.** An OpenAI-shaped `/models` answer
carries no context at all, so a local provider's list also asks LM Studio's
`/api/v0/models`. **Only `loaded_context_length` is taken** — the window the server
has actually reserved for the model it has loaded. An unloaded model reports only
`max_context_length`, which is what it *could* take; storing that would be a worse
lie than storing nothing, because the watchdog would never compact and the server
would truncate the middle of the prompt instead of failing. Measured: 39,168
loaded and 262,144 maximum for a 27B at IQ3_S, and the other seven models on that
machine report no window at all until each is loaded once. A remote vendor is not
probed (`type: openai`) — one request fewer to a billed endpoint, for an answer it
does not have.

Refresh also **updates** the windows of models already in the list, not just the
ones it adds: reload a model with a different context and the number follows. A
model the server currently has unloaded keeps the last value measured for it
rather than being erased, and the status line says how many still have none.

**A provider removed in Settings stops being served.** The engine's `provider`
map is rebuilt from Synapse's config on every start (it used to be merged into
whatever was already on disk, which left a deleted provider's models in the menu
for ever — the `bionic` rename is what surfaced it). A provider with no models
yet is kept in Synapse's config and left out of the engine's, so half-finished
work survives a save without registering an empty catalog.

The same `providers` list carries a billed vendor, not just a local server. DeepSeek
publishes an OpenAI-format endpoint, so it needs no code — one entry, and it appears
in the picker with a **DeepSeek** badge beside its models:

```json
{ "id": "deepseek", "name": "DeepSeek",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKey": "env:DEEPSEEK_API_KEY",
  "models": [
    { "id": "deepseek-flash",   "name": "DeepSeek Flash", "context": 1048576, "output": 65536 },
    { "id": "deepseek-v4-pro",  "name": "DeepSeek Pro",   "context": 1048576, "output": 65536 }
  ] }
```

**The key never goes in the config file.** It lives in `data\provider-keys.json` —
the pattern Peri.Scope uses for the secrets its own config must not carry: a small
JSON file beside the app's data, which `.gitignore` already covers. The tracked
config keeps only the provider's shape. `providerApiKey()` in `src/config.js`
resolves in this order:

| stored in | means |
|---|---|
| `data\provider-keys.json` | what the operator typed in Settings — wins over everything |
| `"apiKey": "env:DEEPSEEK_API_KEY"` | read that variable (`setx …`, then restart Synapse) |
| `"apiKey": ""` | the conventional `<ID>_API_KEY` if it is set; otherwise a keyless server, which is not an error |

A key typed in the Settings field is sent once, over localhost, and written to
that file by `reconcile()` in `src/api.js`; the config is then saved with an empty
`apiKey`. The browser is never *given* a key: `toClientConfig()` returns
`apiKey: ""` plus `apiKeySet`, `apiKeyMasked` (`sk-liv***7df`) and `apiKeyFrom`, so
the screen can say "a key is stored" without holding one. **Remove Key** sends
`apiKey: null`, which deletes the entry.

Everything downstream — the model cache, the picker, the probe, the role cards —
treats these models exactly like the engine's own. The badge comes from
`providerLabel()` in `web\app.js`: **Local** for anything on this machine, the
provider's own name otherwise.

What the vendor's docs say about these two (Oct 2026, not measured here): **1M
context, 384K max output**, tool calls on both, vision on Flash only, thinking mode
**on by default at `high`**. That last one matters for cost: the OpenAI format
switches it with `{"thinking": {"type": "disabled"}}` and scales it with
`reasoning_effort`, and the engine's `low/medium/high` variants map to the vendor's
`low/high/max` — so `medium` is *not* a middle setting here, it is high. `output` is
set to 65536 rather than the API's 384K because it is the engine's per-turn budget,
not a capability claim: a turn that writes more than that has gone wrong.

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
