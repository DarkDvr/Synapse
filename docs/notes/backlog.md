# Backlog — worth discussing, not built

Ideas that survived a first look but were not taken. Each says what it would change
and why it is not already done; nothing here is a promise.

## Project facts in the brief

Workers spend their first turns discovering what a project is: language, package
manager, test command, entry point. A scanner could cache that once per project and
put three lines at the top of every brief.

Not done because the Architect already writes the task detail, and a wrong guess about
the stack is worse than no line. It needs a detection pass that is honest about "not
sure", and a way for the operator to correct it.

## Batch reads

A policy-checked `read_files` (up to eight paths, line numbers, per-file cap) instead
of eight `read` calls. It saves turns, not context, and the engine's `read` already
takes offset and limit. It would also bypass the engine's gate, so it would have to
call `decide()` for every path.

## A fallback model for every role

The coder ladder exists; the other roles do not have one. If the Architect's provider
dies at 2am the run ends, even when another configured model could take the
conversation. Not done because "the role's model" is the operator's choice and
switching it changes which model is judged. It needs a rule for when to switch, what
the Architect is told, and whether the conversation carries.

## A verifier for the Architect's own edits

The checks and diff cover a delegation; the Architect's own turn can still edit a file
with no second pair of eyes. A read-only "what changed since your last message" line
would make its own changes visible. Not done because the Architect is told not to
build, and a line that reports its edits could read as permission to make them.

## The local model engine's own counters

A local manager exposes per-request `decode_tok_s`, `hit_rate`, `pcie_share`,
`drafts_offered/accepted`, and a `conversation_cache` with
`reused_tokens / prompt_tokens`. Read and measured on 20 Nov, not wired in: the
operator already sees those numbers in the engine's own app.

Two traps recorded so nobody proposes the obvious thing again:

- **`hit_rate` is the expert-cache hit rate**, not the prompt cache: MoE expert
  lookups served from the expert store. The card's "92% cache" is the prompt prefix
  cache, from the engine's own `cache.read`/`input`. Putting one under the other's
  label would be a wrong number the operator would believe.
- **The prompt cache in that payload is `reused_tokens / prompt_tokens`** — the same
  quantity the card shows, but per finished request and local-only; ours is per step
  from the stream, which is finer. Speed is the same story: the card counts streamed
  deltas, which beats polling a sampled counter.

If it is ever wanted, the shape is an optional `metricsUrl` per provider, polled
server-side while a run on that provider is live (1 Hz, 3–5 s timeout, a miss is a miss
and never "provider down"), shown in the role card's tooltip. The only genuinely new
readings are the expert cache, the PCIe share and speculative acceptance.
