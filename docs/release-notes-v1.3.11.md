# Synapse v1.3.11

A run whose "report" is a tool call the model typed instead of making now says so
in words, and the test suite no longer writes into the provider diary.

## Fixed

- **A tool call written as text is named as such.** In test6, coder-2's first turn
  ended with `<tool_call><function=websearch>…</function></tool_call>` in the
  message: the engine saw text and closed the turn, so the run "completed" with
  no file and raw XML as its report. The Architect read it and re-delegated, which
  was right — but the report now leads with a sentence saying the model wrote a
  tool call instead of making one and nothing ran after that, then quotes what it
  wrote. The outcome stays `completed`: the same model finished the task on the
  next attempt, so one bad turn does not move the ladder.
- **The test suite stays out of `data\provider-errors.log`.** The ladder tests'
  stub models (`opencode/one`, `opencode/two`, `opencode/three`) were writing
  fake "Invalid request: text is required" and "Free usage limit" lines into the
  real diary, beside genuine failures. They are not written now; the diary is
  evidence.

## Notes

- Full suite: 285 tests, plus five new checks in the plan-rule test for the
  tool-call shape.
- Existing fake lines in the diary are left in place: they are dated 30 Oct
  between 15:38 and 15:40 and name the stub models, so they can be told apart.
