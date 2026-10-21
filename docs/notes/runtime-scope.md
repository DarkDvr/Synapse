# A runtime of our own — scope

The question: can Synapse stop borrowing OpenCode and run its own agent loop, so
that "any provider" means any provider without an engine in between? This is the
short answer, the options, and the size of each.

Nothing here is decided. It is written to be argued with.

---

## 1. What the runtime is for today

Synapse calls a small surface (`src/engines/base.js`): create a session, prompt,
read messages, interrupt, list models/skills/agents, permissions. Behind that
surface OpenCode does work Synapse never does:

| the runtime owns | Synapse today |
|---|---|
| the tool loop (schema, call, result, continue) | reads tool parts out of the transcript |
| every tool: read, write, edit, glob, grep, shell, skills, MCP, subagents | chooses which skills a role may see |
| the permission model (allow/ask/deny per tool) | renders the question panel |
| session transcript storage | reads messages, keeps its own `runs.jsonl` |
| context compaction | watches the window and asks for a steer |
| provider auth and the model catalog | writes provider definitions into the engine's config |
| retries inside a turn | retries between turns, with backoff |

That split is why Synapse is ~8k lines and not ~40k: the hardest, most
unforgiving part — a model that calls tools and tool results that come back into
the model — is not ours.

## 2. What "independent" would actually require

Zero dependencies, offline, Node standard library only. A runtime that replaces
OpenCode at feature parity is roughly:

| module | what it must do | size |
|---|---|---|
| `providers/` | chat completions over SSE for OpenAI-compatible endpoints; tool calls; usage; `reasoning_content` replay (DeepSeek requires it when tools are present); Anthropic messages as a second shape | 600–900 |
| `loop/` | turn state machine, parallel tool calls, max steps, cancel, streamed events in the shape the UI already speaks | 400–600 |
| `tools/` | read, write, edit, glob, grep, shell, skill, websearch, subagent; each with a permission gate | 700–1000 |
| `store/` | sessions and transcripts on disk (JSONL, ours) | 250–350 |
| `context/` | token estimation, compaction policy, the boundary with the existing watchdog | 250–350 |
| `skills/`, `mcp/` | skill loading (file text), MCP over stdio JSON-RPC if MCP tools stay | 350–500 |
| `catalog/` | models.dev snapshot vendored, plus per-provider `/models` and our own limits | 200 + data |
| `engines/synapse.js` | the adapter implementing today's contract over all of the above | 200–300 |

**3,000–4,200 lines**, and the risk is not the line count. It is tool-call
reliability: a loop that mostly works fails exactly where a project is expensive —
a half-applied edit, a shell command that never returns, a model that calls the
same tool twice. OpenCode has had that beaten into it against many models; a fresh
loop re-learns it on our runs.

OpenCode is **MIT**, so its loop and tools could be ported (with attribution)
rather than rewritten. Porting a Go/Bun codebase into dependency-free Node is not
a copy-paste either — call it half the work of writing it, with the same
adaptation risk.

## 3. Three options

**A. Keep borrowing the runtime (status quo + what we already do).**
Synapse owns the harness, OpenCode owns the loop. We keep improving the parts that
are ours: provider registry and keys, the catalog, budgets, retries, compaction
signals. Cost: zero new risk. Ceiling: the engine's quirks are ours to work around
(its 200k default, its catalog, its auth store, its config shape).

**B. Hybrid: a "direct" runtime that only runs simple turns.**
Synapse talks to a provider itself for classification, titling, single-shot
answers; OpenCode keeps the tool loop. Cheap (a few hundred lines) but it does not
answer the question — the tool loop is the engine.

**C. Own runtime, OpenCode optional.**
`engines/synapse.js` implements the contract; `engines/opencode.js` stays as the
other implementation and can be selected per project. That is the real target the
operator is describing, and the contract already allows it. Cost: weeks, and every
improvement has to be made twice until the old engine is retired.

## 4. What is already in our favour

- **The seam exists.** `src/engines/base.js` + `src/api.js` are engine-agnostic;
  `src/runs.js` (delegation, ladder, retries, watchdog, steer) is ours and stays.
- **Our own layer is the interesting one.** Plans, briefs, roles, the ladder, the
  window watchdog, reports, the census — none of it is OpenCode's.
- **We already write the engine's config** (providers, limits, skills, MCP), so we
  know the exact shape a runtime has to consume.

## 5. The provider model this lands on

Badges are the vocabulary; a provider is an endpoint plus a key.

| badge | endpoint | key | type |
|---|---|---|---|
| OC ZEN | OpenCode inference (`opencode`) | optional — free models need none | OpenAI Compatible |
| OC GO | OpenCode Go (`opencode-go`) | your Go key | OpenAI Compatible |
| DEEPSEEK | `api.deepseek.com/v1` | your key | OpenAI Compatible |
| OPENAI COMPATIBLE | anything | optional | OpenAI Compatible |
| LOCAL | this machine | usually none | OpenAI Compatible **or** Ollama |

There are **two** OpenCode badges, not three. `opencode` *is* OpenCode Zen: the
free models work with no key at all (`apiKey: "public"` in the engine's catalog),
and a Zen key on that same provider unlocks the paid models. `opencode-go` is the
Go plan — genuinely a separate provider with its own key. So "OpenCode" and
"OC Zen" are one endpoint with two credentials, and the badge is the pair
(OC ZEN / OC GO), not the key's presence.

In our own runtime, OC ZEN's key being optional is a property of the provider, not
of the app: the same entry serves free models with no key and paid ones with one.
That is what makes "Add Provider lists all six badges" possible at all — today
three of them are owned by the runtime, and two of the six are the same provider.

## 6. If we do it: staged, each stage shippable

0. **Vocabulary and catalog (days).** Engine → Runtime in the UI and docs; the
   model catalog read from providers and `models.dev` into Synapse's own cache
   rather than trusting the engine's numbers; provider keys and limits already
   ours.
1. **Transport (1–2 weeks).** `fetch`, SSE, tool-call parsing, usage, reasoning
   replay, retries inside a turn. Prove it with one role on one small task against
   DeepSeek and the local server, using the existing session UI.
2. **Tools, read-only first (1–2 weeks).** read/glob/grep/list, then edit/write,
   then shell with the permission gate. A project that only reads is still useful
   for the Designer and the Inventor.
3. **Store and context (1 week).** Sessions on disk in our own shape; compaction
   under our control instead of the engine's 60%-of-window rule.
4. **Switch one role, then one pipeline.** Multi-runtime: a role can name the
   runtime as well as the model. OpenCode stays for anything not yet ported.
5. **Retire** when a shift test passes on the new runtime with no worse cost.

Each stage keeps Synapse working; none of them is a rewrite of the harness.

## 7. What gets better, and what gets worse

**Better:** no engine config to mirror; model windows and compaction under our
own policy; provider keys and catalogs in one place; the tool census becomes
first-hand data instead of parsed events; a 429 is ours to handle exactly once;
and Synapse stops depending on a binary that updates itself.

**Worse:** we become responsible for the loop. Every new model with a quirky
tool-call format is our bug; permission handling and shell safety are ours; and
the first month will be spent on reliability, not features.

## 8. Existing runtimes we could use instead of writing one

Surveyed 2026-10: the open-source agent field is mature, and the question is
whether any of it is a *server* Synapse could drive, not a UI.

| candidate | licence | shape | fit for Synapse |
|---|---|---|---|
| **OpenCode** (current) | MIT | HTTP + SSE, sessions, tools, providers | known; the thing we are considering leaving |
| **Goose** (AAIF / Linux Foundation) | Apache 2.0 | Rust; desktop, CLI and "an API to embed it"; 70+ MCP extensions, subagents, ACP providers | **closest analogue.** Needs a spike: is `goosed`'s HTTP surface as complete as OpenCode's (sessions, tool events, permissions)? I have not driven it |
| **OpenHands** | MIT | Python; server + websocket; sandboxed workspace, Docker-based execution | real server, but heavyweight: a Python service and a container per workspace |
| **Codex CLI** | Apache 2.0 | Rust CLI with an `app-server` JSON-RPC mode | good tool loop; a subprocess protocol rather than a server, and OpenAI-shaped |
| **Cline / Kilo Code** | Apache 2.0 | VS Code extension + headless CLI (JSON) | no long-lived server; would mean shelling out per task |
| **Aider** | Apache 2.0 | CLI, git-native, architect mode | excellent loop for edits as commits; not a session server |
| **Tabby** | Apache 2.0 | self-hosted completion server | completion, not an agent loop |

**The cheap-independence test** is therefore not "write 4,000 lines" but "spike
Goose": if `goosed` can hold a session, run tools and stream events over local
HTTP, then an `engines/goose.js` adapter next to `engines/opencode.js` is a few
hundred lines, not weeks. The adapter contract already exists, so the spike is
bounded and reversible — and it would also tell us whether a second runtime is
cheap in general, which is the real question behind the whole plan.

Worth noting from the survey: the field consolidates (Continue.dev acquired,
Roo Code archived in 2026), which is an argument for owning the *contract* and
keeping more than one runtime able to satisfy it.

## 9. Recommendation

Do **0** now — it is cheap, it improves today, and it is needed either way. Then
decide between C and A once stage 1 is proven on a real task, because the cost of
C is dominated by the loop and the tools, not by the transport.

If C is chosen, port rather than reinvent where the licence and language allow,
and never run two runtimes for the same role in the same run.
