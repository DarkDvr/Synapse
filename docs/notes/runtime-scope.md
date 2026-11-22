# A runtime of our own — scope

The question: can Synapse stop borrowing OpenCode and run its own agent loop? This is
the short answer, the options, and what each costs. **Nothing here is decided** — the
app still drives `opencode.exe`, and this note is the argument against doing otherwise
in a hurry.

## What the runtime is for today

Synapse calls a small surface (`src/engines/base.js`): create a session, prompt, read
messages, interrupt, list models/skills/agents, permissions. Behind it, OpenCode does
work Synapse never does:

| the runtime owns | Synapse today |
|---|---|
| the tool loop (schema, call, result, continue) | reads tool parts out of the transcript |
| every tool: read, write, edit, glob, grep, shell, skills, MCP, subagents | chooses which skills a role may see |
| the permission model | renders the question panel |
| transcript storage | reads messages, keeps its own `runs.jsonl` |
| context compaction | watches the window and asks for a steer |
| provider auth and the model catalog | writes provider definitions into the engine's config |
| retries inside a turn | retries between turns, with backoff |

That split is why Synapse is ~29k lines and not ~70k: the hardest part — a model that
calls tools and tool results that come back into it — is not ours.

## What "independent" would cost

Zero dependencies, standard library only, at feature parity: roughly 3,000–4,200
lines — providers (SSE, tool calls, usage, reasoning replay, Anthropic as a second
shape), the turn state machine, nine tools with a gate each, a transcript store,
context and compaction, skills and MCP, a vendored catalog, and an adapter.

The risk is not the line count. It is tool-call reliability: a loop that mostly works
fails exactly where a project is expensive — a half-applied edit, a shell command that
never returns, a model that calls the same tool twice. OpenCode has had that beaten
into it against many models; a fresh loop re-learns it on our runs. OpenCode is MIT,
so its loop could be ported with attribution — call that half the work, with the same
adaptation risk.

## Three options

**A. Keep borrowing the runtime.** Synapse owns the harness, OpenCode owns the loop.
Cost: zero new risk. Ceiling: the engine's quirks are ours to work around.

**B. Hybrid.** Synapse talks to a provider itself for classification, titling and
single-shot answers; OpenCode keeps the tool loop. Cheap, and it does not answer the
question.

**C. Own runtime, OpenCode optional.** `engines/synapse.js` implements the contract and
`engines/opencode.js` stays as the other implementation, selectable per project. That
is the real target, and the contract already allows it. Cost: weeks, and every
improvement made twice until the old engine retires.

## What is in our favour

The seam exists (`base.js` + `api.js`), and the interesting layer is ours already:
plans, briefs, roles, the ladder, the watchdog, reports, the census. We also write the
engine's config, so we know the exact shape a runtime has to consume.

## The provider model this lands on

A provider is an endpoint plus a key, and the badge is the pair (OC ZEN / OC GO), not
the key's presence: `opencode` *is* OpenCode Zen, where free models need no key
(`apiKey: "public"` in the catalog) and a Zen key unlocks the paid ones; `opencode-go`
is the Go plan, a genuinely separate provider. That is why "Add Provider lists all six
badges" is possible only once the runtime stops owning three of them.

## If we do it: staged, each stage shippable

0. **Vocabulary and catalog (days).** The model catalog read from providers and
   `models.dev` into our cache rather than trusting the engine's numbers.
1. **Transport (1–2 weeks).** `fetch`, SSE, tool-call parsing, usage, reasoning
   replay, in-turn retries. Prove it with one role on one small task.
2. **Tools, read-only first (1–2 weeks).** read/glob/grep/list, then edit/write, then
   shell with the gate.
3. **Store and context (1 week).** Sessions on disk in our shape; compaction under our
   policy instead of the engine's rule.
4. **Switch one role, then one pipeline.** A role may name the runtime as well as the
   model.
5. **Retire** when a shift test passes on the new runtime with no worse cost.

## Existing runtimes, surveyed

OpenCode (MIT, HTTP + SSE) is the current one. **Goose** (Apache 2.0, Rust, "an API to
embed it", 70+ MCP extensions) is the closest analogue and has not been driven: the
bounded spike is whether `goosed` can hold a session, run tools and stream events over
local HTTP. If it can, an `engines/goose.js` adapter is a few hundred lines rather
than weeks. OpenHands is a real server but a Python service and a container per
workspace; Codex CLI is a subprocess protocol; Cline, Aider and Tabby are not session
servers.

## Recommendation

Do **0** now: it is cheap, it improves today, and it is needed either way. Then decide
between C and A once stage 1 is proven on a real task, because the cost of C is the
loop and the tools, not the transport. If C is chosen, port rather than reinvent where
the licence and language allow, and never run two runtimes for the same role in one
run.
