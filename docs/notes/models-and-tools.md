# Models and tools

The catalog, the thinking-effort variants, what Synapse remembers about a model, the
probe, and how the engine is updated. Read it before touching model selection,
`src/windows.js` or `src/modelcache.js`.

## Every role's model is the project's

Every project has `.project\roles.json`: its own Architect, Inventor, Designer, QC,
Coder 1 and Coder 2, with a model ref and thinking effort each. The config's `roles`
remain the **template** — skills, instructions, timings — and the starting point for a
project that has never written a role.

- `api.sendMessage` reads the project's Architect entry first, then the session model
  (for projects written before the file), then the config.
- `src/runs.js` merges the project's role map over the config when it chooses a
  worker; the ladder, the model marks and the attempt history all use that merged
  view.
- `web/run-view.js` `selectionFor(role)` reads the open project's `roles[role]`; with
  no chat open it reads the newest project, so a new project inherits the whole set.
- Changing a role while a project is open writes only that project's file. The
  Architect's chat is switched at once; a worker that was waiting in a backoff is
  woken; a live worker finishes on its old model and the next delegation reads the
  file.
- Changing a role with no project open writes the config template.
- The model drop-down breathes while the save is in flight and stops when it returns.
- A global role change is a template change, not a project change: projects with a
  role file keep their own choice.

## The cache share on a card

The card says `120k/262k ctx (92% cache)`. The prompt is `input + cache.read` from the
step's usage, and the share is `cache.read / (input + cache.read)`:

- a cloud model with prompt caching reports both numbers;
- a local server reports them when it does KV reuse (llama.cpp, LM Studio) and nothing
  when it does not — then there is no share, and none is shown;
- the share is **refused** when the sum exceeds the window, the signature of a provider
  reporting `cache.read` as a running session total (a 27B reported five million against
  a 262K window on 12 Nov). A percentage built on that would be fiction.

The Architect's card takes the halves from the streamed event and the transcript; a
worker's from `promptParts()` through `run.progress`.

## Tools and models

- **The toolset is per-model, per-agent and even per-call.** One run reported `execute`,
  the next did not. Never hardcode an assumption about which tools exist — the probe
  asks the model and reports it. Observed: `edit, glob, grep, question, read, shell,
  skill, subagent, webfetch, websearch, write, execute`. There is no `list` and no
  `todowrite`.
- **`question` is the form mechanism, and the form is the interface.** The call blocks
  the session and the engine raises a **form**: `GET /api/session/{id}/form` lists it,
  `POST .../form/{formId}/reply` with `{answer:{<key>: value}}` settles it. Fields are
  `string` (with `options` → a choice, `custom: true` → an escape hatch),
  `multiselect`, `boolean`, `number`/`integer`, `external`, with `required`, `hidden`
  and `when` (eq/neq on another key). Missing one stalls a session forever.
  **The global form list is location-scoped and will not show a project's form**
  (`GET /api/form` lists only the engine's own location), which is why the first real
  question showed up as a raw JSON tool card while the session sat blocked. Ask the
  session, not the world: `GET /api/pending?session=<id>`.
  **Forms live in the engine's memory.** A Synapse restart restarts the engine and every
  pending form dies with it: the transcript is left with a tool part stuck at `running`
  and the turn never resumes. Interrupt the session before a restart if a question is
  open.
- **Tools are fast; models are slow.** Measured tool execution: file tools 10–130 ms,
  shell ~300 ms, `webfetch` ~180–330 ms, `execute` ~50 ms. Turn times are 3–80 s because
  of model latency. Judge tools by their own `time.completed - time.created`.
- **The free tier throttles.** "OpenCode's free tier can only be used from within
  OpenCode" is intermittent, not a ban, and **every test turn spends the operator's
  quota** — batch checks, and prefer one turn that proves several things. Evenings are
  slower; expect 10+ minute turns and rate limits up to half an hour.
  `data\provider-errors.log` is the record.

## Context windows and thinking effort

`GET /api/model` reports `limit.context`, `limit.output` and `variants`; each variant
sets a `reasoningEffort`.

- **Omitting a variant is not "no effort".** The engine stores `variant:"default"`,
  which is not an advertised variant. Measured reasoning tokens on one task: `low` 70,
  default 228, `max` 719.
- **The catalog is conservative.** DeepSeek V4.1 Flash Free advertises 200k but the
  backend serves **1,048,576** (boundary-tested: ~1.037M OK, ~1.107M 400). Others are
  genuinely 200k, so **never raise a limit without testing that model**.
- **There is no such thing as "the" context window, so nothing may assume one.** Hosted
  models here are ~1M or 200k; a local model may be 62k. Even the engine does not compact
  at the model's limit: it auto-compacted at 290k on a model advertising 1M. Compaction
  is not a schedule and not a token number.

### The window watchdog (`src/runs.js`)

`windowRoom({context, output})` = `context - output - max(8k, 5% of context)` — the room
left for the next turn's own output and for what it will pull in.

- It fires when *that model's* recorded window is about to be reached, once, and re-arms
  only after the transcript has fallen below 70% of the room.
- **A window nobody recorded gets no watchdog at all.** `modelCache.get(ref)` or the
  operator's `modelLimits` is the only source; guessing is how a 62k local model would be
  treated like a 1M hosted one.
- It runs inside `waitForIdle`, which already has the messages on every 1.5 s poll, so it
  costs no extra engine call.
- `POST /api/session/{id}/compact` is "durably admit a session compaction request … it
  runs at the next step boundary", so it is safe mid-run; a 409 means one is queued. The
  transcript is kept; only what the model is sent is replaced.

This is a safeguard, not a strategy. The failure it prevents — an oversized request — is
the one error a retry can never fix. Prevention is shorter tasks and batched tools.

### What the engine actually does (read out of its bundle, 2.1.2)

```
threshold = context − max(floor(context × 0.15), context ≥ 32,000 ? 16,000 : 0)
fires when   last step's (input + cache.read + cache.write + output + reasoning)
             + an estimate of the tool results that arrived since >= threshold
```

- The reserve is **15% of the context, but never less than 16,000 tokens** — on a 42,240
  window that is 16,000, and it compacts at **26,240**; on 1,048,576 it is 15% →
  891,290.
- The count is not the provider's prompt size: it adds an *estimate* of the tool results
  waiting to be sent, which is why a run can compact at 19,981 one minute and 26,812 the
  next.
- `compaction.buffer` replaces that reserve; `compaction.auto` defaults true; `keep`
  defaults to **15,000** tokens, which is why a compacted transcript comes back at ~11k
  and refills within a few turns.
- `output` plays no part: the reserve is a flat share of `context`.

**What a compaction leaves behind, measured** (one local run, 60,160): summary written =
2,552 output tokens; the first prompt after it = 10,613, so about 8,061 tokens were
conversation carried over verbatim. The summary cannot be shortened — it is a template
inside the engine's binary — but the tail can: `engine.opencode.compactionKeepTokens`
writes `compaction.keep.tokens`. Default 0 keeps the engine's 15,000; a smaller number
lowers the floor after every compaction and costs the worker that much verbatim context
when it resumes.

**The number the engine compacts on is the number the engine was told** — the
catalog/provider-config copy, not what the runtime has loaded. When the two differ the
engine wins, because it is the thing that compacts.

### Where the window comes from, and which source wins

One module owns this: `src/windows.js`. It used to be worked out in four places from
four sources that could disagree, and five rounds of fixes never ended because each fix
corrected one copy (a model loaded at 128k, the card saying 60k).

**The rule is measurement beats claim**, one function `resolveWindow()`:

| | beats | loses to |
|---|---|---|
| loaded (asked of a local server) | everything | nothing |
| operator override | refused, provider entry, catalog | loaded |
| refused (a provider said no) | a catalog larger than it | loaded, override |
| provider entry | catalog | the three above |
| catalog | nothing | all four |

- **What a local server has loaded** is asked at boot, when a role's model is chosen, and
  once per run. Three dialects, one deadline:

  | endpoint | who answers | where the window is |
  |---|---|---|
  | `/api/v0/models` | LM Studio | `loaded_context_length`, per model |
  | `/props` | llama.cpp family | `default_generation_settings.n_ctx`, for the one loaded model |
  | `/v1/models` | a wrapper's own list | `meta.n_ctx` |

  Only what is *served* counts: `max_context_length` is what the model could take and is
  skipped. A model nobody loaded has no window. Storing a maximum would be worse than
  storing nothing — the server would truncate the middle of a prompt instead of failing.
- **A provider model's `limit` is all or nothing** (measured 2.1.2): `limit: { context }`
  alone makes the engine answer `skipped malformed recognized value` and **drop the whole
  provider**. `opencode.js` therefore always writes the pair, filling an unchosen output
  with the engine's default 32,000.
- **A refusal is the cloud equivalent** of a measurement: `classifyFailure` labels it
  `kind:'context'`, `modelCache.noteContext()` records the size, and the next turn budgets
  below it. A catalog that later reports a different window clears the refusal.
- **Both spellings of the key are honoured:** the engine config takes the bare model id,
  Synapse's ref is `provider/model`, and `modelLimits` may be written either way.
- **The number is remembered** — `knownWindow()` answers from one resolved value per
  model ref, and it changes only when a measurement, an edit or a model change says so,
  never because a lookup missed. A selection is measured immediately, so the card shows
  the real window before the model is used.
- **A server that is not answering changes nothing**: the last known window stands.

The incident that proves it (22 Oct): a local model with 60,160 loaded and
`limit.context: 42240` in the engine config compacted six times in thirteen minutes at
prompt sizes of 19,981–26,812, every one `"reason":"auto"`, and the watchdog never fired
because it was waiting for 45,968. The warning that would have told us was logged at INFO
on a channel not mirrored to the console, and read like good news. It is a boot-time
measurement now. The cost of the bug is the shape: a *silently* wrong number the harness
acts on forty-nine times (Fever Tracker's t7: 86 turns, 81 minutes, 49 compactions).

The operator sees it live: the role card carries `27k/60k ctx` beside the rate, and every
compaction adds a pinned amber line to the worker's trace.

## Other model servers

`engine.opencode.providers` registers any OpenAI-compatible server — a local LLM, a
second vendor — and it appears in the model menu:

```json
"providers": [
  { "id": "bionic", "name": "Bionic",
    "baseURL": "http://localhost:1235/v1", "apiKey": "",
    "models": [{ "id": "qwen3.8-27b-ud", "name": "Qwen 3.8 27B UD" }] }
]
```

`src/engines/opencode.js` writes each into the engine's config as `provider.<id>` with
`npm: "@ai-sdk/openai-compatible"`, `options.baseURL` and a `models` map — **`provider`
singular for definitions, `providers` plural for per-provider overrides**, and swapping
those two names is silent. Nothing is contacted until a model is picked and a turn runs.

- `context`/`output` are optional per model and are the only honest source for the
  watchdog. Left out, the engine reports its own default 200,000, which is not the local
  model's real window. Measured: a 27B on `localhost:1235` answered a turn in **18 s**.
- **A local server is one of two list formats.** `format: "openai"` answers `GET /models`;
  `format: "ollama"` answers `GET /api/tags` (`{name}` rather than `{id}`). Chat goes
  through the OpenAI URL either way — Ollama serves it at `/v1` — so `format` only decides
  which list endpoint `Refresh List` asks first; the other is tried after a 404.
- **The address decides whether a provider is local, not the type it was saved as.** An
  OpenAI-Compatible row with a localhost URL is a server on this machine: the Local LLM
  row counts it, the probe asks it, the picker badges it LOCAL. Red "no answer" is only
  claimed when *no* registered local server answers.
- **The provider order is the operator's**, saved as `engine.opencode.providerOrder`; a
  role card's menu lists providers in exactly that order, and an unmentioned id keeps its
  default place at the end.
- **The engine's own two providers can be removed and put back.** The ✕ on `opencode` or
  `opencode-go` adds the id to `engine.opencode.hiddenProviders` and filters its models
  from what is offered; nothing is unregistered, and a role already pointing at one keeps
  working with a card that says "hidden in Settings". Add Provider lists them again.
- **A provider removed in Settings stops being served.** The engine's `provider` map is
  rebuilt from Synapse's config on every start; a provider with no models yet is kept in
  Synapse's config and left out of the engine's.

## A vendor's own API

**The way in is Settings → Providers**, not a hand-edited file: the tab lists the
engine's built-in catalog as its own rows and every registered provider below it, and
offers *Local Provider* and *OpenAI Compatible* (the ids differ only by where they point).
Saving writes the same `providers` array a hand-written entry would.

DeepSeek publishes an OpenAI-format endpoint, so it needs no code:

```json
{ "id": "deepseek", "name": "DeepSeek",
  "baseURL": "https://api.deepseek.com/v1",
  "apiKey": "env:DEEPSEEK_API_KEY",
  "models": [
    { "id": "deepseek-flash",  "name": "DeepSeek Flash", "context": 1048576, "output": 65536 },
    { "id": "deepseek-v4-pro", "name": "DeepSeek Pro",   "context": 1048576, "output": 65536 }
  ] }
```

**The key never goes in the config file.** It lives in `data\provider-keys.json`, which
`.gitignore` covers. `providerApiKey()` resolves in this order:

| stored in | means |
|---|---|
| `data\provider-keys.json` | what the operator typed — wins over everything |
| `"apiKey": "env:DEEPSEEK_API_KEY"` | read that variable, then restart Synapse |
| `"apiKey": ""` | the conventional `<ID>_API_KEY` if set; otherwise a keyless server, which is not an error |

A key typed in Settings is sent once over localhost and written to that file by
`reconcile()`. The browser is never *given* a key: `toClientConfig()` returns `apiKey: ""`
plus `apiKeySet`, `apiKeyMasked` (`sk-liv***7df`) and `apiKeyFrom`. **Remove Key** sends
`apiKey: null`.

The badge comes from `providerLabel()`: **Local** for anything on this machine, the
provider's name otherwise. For DeepSeek the vendor's docs (Oct 2026, not measured here)
say 1M context, 384K output, tool calls on both, thinking on by default at `high` —
`reasoning_effort` maps low/high/max, so `medium` is *not* a middle setting, it is high.
`output` is set to 65536 because it is the engine's per-turn budget, not a capability
claim.

## The model cache (`data\model-cache.json`)

Models come and go; what we learned about one should outlive it leaving the catalog. The
picker is built from the engine's **live** catalog every launch: the cache only supplies
what we learned about a model that is still there, and never adds an entry of its own.
`src/modelcache.js` is keyed by the full `provider/id` ref, because the same model can
exist in more than one category. Each record holds name, provider, context/output,
variants (`{id, label}`), capabilities, `firstSeen`/`lastSeen` and the discovered toolset.
`engine.listModels()` is recorded on every boot and every `GET /api/models`.

- **Each model is asked at most N times, ever** (default 3). The first selection fires
  `POST /api/models/inspect`; the server answers from cache when a valid tool list
  exists, refuses to stack a duplicate run, and serialises runs one at a time. A
  completed run counts even when the answer is empty; at the cap the model is
  `exhausted` and never asked again. Synapse re-asks on boot for any role's current model
  still missing a list. Settings has **Reset Ask Counters**.
- The discovery prompt asks the model to list its tools; `parseToolNames` takes the last
  dotted segment then keeps `[a-z0-9_-]` (MCP names contain hyphens — an earlier parser
  dropped them and turned `synapse-search_websearch` into `synapsesearch_websearch`).
- When a check finishes, `model.probed` goes over SSE and the tooltips gain `· N tools`.
  The picker menu shows a source chip so two entries with the same display name cannot be
  confused.
- **A model can be marked, and only the operator unmarks it.** A provider refusal during
  a worker run writes the provider's own sentence into the record
  (`issues: [{at, kind, message}]`, newest first) and broadcasts `kind:'model'`. The row
  grows an orange **ISSUES** chip, the closed picker's border goes amber, and **clicking
  the chip clears it** — no turn, no question, nothing written to the plan: "UI-only, only
  me". The mark survives a restart, because a retired model is still advertised and the
  picker would otherwise show it as healthy (`space-bunny-free`).
  **The record does not block a selection and is never mentioned in a brief.** The one
  place it is policy: a task whose planned role is marked starts one rung lower
  (`roleMarked`), so a known-broken model costs a task its first turn, not every task.
- **The probe marks a model that cannot drive tools.** It counts *real* failures (a case
  whose tool the model was never offered does not count) and **3 or more** writes a
  `kind:'tools'` issue. Three because a probe is one turn per case against a flaky
  provider. **No probe clears a mark**: a mark clears when the model delivers a completed
  run, or when the operator clears it.
- `GET /api/models/cache` exposes the store for debugging.

## Is there a newer engine? (`src/engine-update.js`)

The catalog ships inside the engine binary, so a stale model list is nearly always a
stale *engine*. A yellow **Update** chip appears when a newer one is known, and is absent
when nothing is.

- **Two sources, because they fail differently.** OpenCode Desktop ships its own engine,
  so its `resources\opencode-cli.version` is read locally at boot — instant, offline, and
  on this machine the signal that actually arrives. npm
  (`registry.npmjs.org/@opencode/cli`) is asked **only when the dialog opens or Check
  Again is pressed**: the app is offline by rule, and a check the operator asked for is
  not the app phoning home. The answer is cached in `data\engine-update.json`.
- **The npm answer replaces the cached one** rather than raising it, or a wrong cache
  would be sticky for ever.
- **Updating is stop → `npm install -g @opencode/cli@latest` → start**, and that order is
  not a preference: a running `.exe` cannot be replaced on Windows. The engine restarts
  in-process, so the UI stays up and the tab survives (measured 9.4 s, sessions and
  transcripts intact). A failed install still restarts the engine, because being down is
  worse than being old.
- **It refuses while work is in flight** — a live delegation, or any session
  `/api/session/active` reports, which includes one blocked on a question — and it
  refuses an engine Synapse did not install with npm (`packageRoot()`), rather than
  installing a second engine somewhere else.
- **`npm` cannot be run with `execFile` on Windows**; it goes through `cmd.exe /d /s /c
  npm …` with array arguments.
- The dialog is honest about what it does not know: npm publishes no release notes for
  this package, and it says so instead of inventing a changelog.

## The probe (`Run Tool Probe`)

One turn per tool in a disposable scratch session (`<projects root>\_probe`), recording
the tool's own execution time, and labelling a failure "not offered by this model" when
the tool was never in its list.

- It **interrupts a timed-out case** before starting the next, or the wedge is inherited
  and every later case fails too.
- **The scratch session is invisible.** Probe and model-check sessions live in `_probe`;
  the API filters that directory out of project and session lists, and `probe.sweep()`
  deletes leftovers at boot.
- Results persist to `data\probe.json`. The panel does not print the model name or the
  toolset: a probe is a question about the *tools*, and per-case results are the view.
  The ref stays in the file for a result that looks impossible.

## The tool census

Every finished turn is scanned once and its calls recorded (by part id, so re-reading a
transcript never double-counts) into `data\tool-stats.json`: per tool and per model —
calls, failures, exit codes, average execution time, and the last 20 error signatures.
`GET /api/tools/stats` serves it; the rail's **Tools in use** panel shows the live
summary.

It describes *now*, not history, so it **clears on every boot** (`tools.resetOnBoot`, on
by default; Settings can keep it), and Settings has **Clear Tool Census**. Left to
accumulate it stops describing the environment: after a few days it read 184 calls from
sessions that no longer existed.

## Numbers that were not what they said

Measured 23–24 Oct against a provider whose own server log prints its speed per step.

**"0% thinking" was a claim we could not make.** The run line takes the thinking share
from `tokens.reasoning`, and this provider reports `reasoning: 0` while putting the
thinking inside `output` (43,526 characters of reasoning, 14,875 output tokens, no
split). The line now says *thinking included, not counted separately*
(`contextStats().thinkUnsplit`).

**The card's speed was the whole step, not the writing.** Usage arrives once per step, so
dividing written tokens by the gap between two usage events also divides by the tool that
ran and the round trip. The provider's own log is the measurement: 60 tokens in 8 s is
93.4 tok/s by its clock and 7.5 by ours, because it divides by the time between the first
token and the last. The page keeps the first and last of each step's deltas
(`deltaWindow`) and divides the step's tokens by that span.

Two later corrections to the same window:

- **the window was missing the tool call** (13 Nov): a tool call's arguments are
  `tokens.output` — a `write` of a whole HTML file is thousands — but they arrive as
  `session.tool.input.started`/`.ended`, not deltas. A step that wrote a file divided the
  file's tokens by the seconds it spent thinking around the write, so the card read 2–4×
  the provider's figure (279 vs a true 161). The window now opens on the first delta *or*
  `tool.input.started` and closes on the last delta *or* `tool.input.ended`;
  `tool.called`/`tool.success` are excluded, because the tool's own running time is not
  the model writing.
- **an event lost with the stream was a second step divided by one step's time.**
  `forgetUsageSamples()` re-baselines on reconnect: the next usage event becomes the
  baseline and no sample is taken across the gap.
- **a buffered step is not a fast one** (26 Nov). A local server can release a whole
  step's stream at the end: a 1,083-second step showed 139 seconds of deltas, so 32,000
  output tokens read 230 tok/s while the server's own pace was about 35. The step's
  own clock is now the denominator when the delta window is less than half of it and
  no tool ran; a tool step keeps the shorter window because the tool's execution is
  not model writing. `writingWindowMs` in `web/rate-view.js` owns the rule.

## A provider's error wears its own clothes

A turn failed with `'charmap' codec can't encode character '\u2713'` and it looked like
Python inside Synapse. Nothing here runs Python: the **model server** had raised a
`UnicodeEncodeError` inside itself and handed the text back as an error object in a 200
response. The engine labelled it `provider.internal`.

- **Read the engine's raw message before believing a stack trace's owner.**
  `GET /api/session/{id}/message` on 8720 (Basic auth
  `opencode:<data\engine\opencode\password.txt>`) carries the `error.type`, the status and
  the provider's body. `provider.internal` means the provider, whoever wrote it.
- **`PYTHONIOENCODING=utf-8` in the engine's environment reaches the engine's children,
  not the provider.** The model server is launched by the operator and needs it at its own
  start.

**A provider error inside a 200 is a failed turn, not an outage.** An SSE response sends
its status before the first token, so a failure after that can only arrive as an error
frame or as a 200 whose body is `{"error": …}`. The runner read only the sentence,
classified it "unknown" and retried, so one provider bug became ten identical failures.
Now `providerErrorFrame()` parses `error.response.body`, `normalizeMessage` marks the
message `errorKind: 'provider-frame'`, `turnErrorOf` reports it as "the provider returned
an error inside its response: <their sentence>", and `classifyFailure` maps it to
**terminal** / `provider-frame`. Everything else on the ladder is untouched — a rate limit
is still transient.

## The model list, asked once at boot

A provider's list in Settings is a snapshot from the last Refresh, and on 17 Nov OpenCode
Go's was months old: models it had added were missing and models it had dropped were
still offered. The engine reads its provider definitions once, at start, so a list learned
after that start cannot run until the next restart — which is why this is a boot step.

- `syncProviderModels()` asks every provider in parallel under **one three-second
  deadline**, before the engine is configured.
- **An answer is authoritative for ids.** A model the provider no longer lists is
  removed, because a role pointing at it could not run and the operator needs to see that
  now. New ids are added.
- **The operator's entry survives** for a model still listed — its name, window, output.
  A `/models` listing is not a measurement of anything.
- **No answer changes nothing.** Timeout, 401, an empty list, HTML: the saved list stands.
  The page says it once — a line per provider that changed (`(+added, -removed)`), then
  one sentence for the providers that did not answer.
- A role whose saved ref is no longer in the catalog shows an **empty model field with a
  red border**, and sending is refused with the reason, in both modes.
