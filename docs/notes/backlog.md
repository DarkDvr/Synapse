# Backlog — worth discussing, not built

Ideas that survived a first look but were not taken in 1.59. Each says what it
would change and why it is not already done; nothing here is a promise.

## Project facts in the brief

Workers spend their first turns discovering what a project is: the language, the
package manager, the test command, the entry point. A small scanner could cache
that once per project (a `package.json`, a `pyproject.toml`, a `*.csproj`, the
first lines of a README) and put three lines at the top of every brief.

Not done because the Architect already writes the task detail, and a wrong guess
about the stack is worse than no line. It needs a detection pass that is honest
about "not sure", and a way for the operator to correct it.

## Batch reads

A policy-checked `read_files` (up to eight paths, line numbers, per-file cap) in
place of eight `read` calls. It would save turns on a worker reading a design
spec, a feature list and two reports.

Not done because it does not save context, only round trips, and the engine's
`read` already takes an offset and limit. It also bypasses the engine's gate, so
the tool would have to call `decide()` itself for every path.

## A fallback model for every role

The coder ladder exists; the other roles do not have one. If the Architect's
provider dies at 2am the run ends, even when another configured model could take
the same conversation. A per-role `fallback` would let the harness switch on a
terminal provider failure and tell the model what happened.

Not done because "the role's model" is the operator's choice, and switching it
changes which model is judged. It needs a rule for when to switch (a dead
provider, not a bad answer), what the Architect is told, and whether the
conversation carries.

## A verifier for the Architect's own edits

The checks/diff work covers a delegation. The Architect's own turn can still
edit a file with no second pair of eyes; QC is the next task, not the same one.
A read-only "what changed since your last message" line in the brief would make
its own changes visible.

Not done because the Architect is told not to build, and a line that reports its
edits could read as permission to make them.

## The local model engine's own counters

A local manager (PolyStrata, `GET http://127.0.0.1:8080/metrics`) exposes per-request
`decode_tok_s`, `hit_rate`, `pcie_share`, `drafts_offered/accepted`, and a
`conversation_cache` with `reused_tokens / prompt_tokens`. Offered to the harness on
20 Nov, read and measured, and not wired in — the operator already sees those numbers
in the engine's own app.

Two traps recorded so nobody proposes the obvious thing again:

- **`hit_rate` is the expert-cache hit rate**, not the prompt cache. It is MoE expert
  lookups served from the expert store (the payload sits it beside `expert_cache_mib`,
  `expert_slots` and `pcie_share`). The card's "92% cache" is the prompt prefix cache,
  from the engine's own `cache.read`/`input`. Putting one under the other's label would
  be a wrong number the operator would believe.
- **The prompt cache in that payload is `reused_tokens / prompt_tokens`** — the same
  quantity the card shows, but per finished request and local-only; ours is per step
  from the stream, which is finer. Speed is the same story: the card counts streamed
  deltas, which beats polling a sampled counter, and the advice that arrived with the
  metrics agrees.

If it is ever wanted, the shape is an optional `metricsUrl` per provider, polled
server-side while a run on that provider is live (1 Hz, 3–5 s timeout, a miss is a
miss and never "provider down"), shown in the role card's tooltip. The only genuinely
new readings are the expert cache, the PCIe share and speculative acceptance.
