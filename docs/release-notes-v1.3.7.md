# Synapse v1.3.7

Permissions that Synapse answers itself no longer flash on screen, and a steer
stays on the sentence's line, in bright yellow, where it cannot be folded away.

## Fixed

- **No more permissions appearing and disappearing.** The engine lists a request
  as pending from the moment it raises it, so a page polling in the milliseconds
  before Synapse's own answer landed could paint a card and take it away on the
  next poll. With every call inside the project allowed by policy, a run looked
  like a stream of cards — with Full auto off, because Full auto had nothing to do
  with it. The gate now marks the requests it is judging, and the pending list
  skips those and anything already decided; only a request genuinely waiting on
  the operator reaches the page.
- **STEER sits on the text's centre line.** The 9.5px tag was nudged 1.5px above
  the baseline, which read as too high over an 11.5px trace line; the trace now
  lays the tag and the sentence out as one row and centres them. The message
  prefix moved inside the text span for the same reason.
- **STEER is bright yellow** (`#ffd60a`), and it cannot hide: the trace keeps the
  last four steps and folds the rest into "N earlier steps", and a steer used to
  fold with them. Every steer now stays in the open tail, the sentence wraps
  instead of being cut with an ellipsis, and a finished trace says `· steered` on
  its folded line.

## Notes

- Full suite: 281 tests, including a gate test for the answering mark, an API test
  that only a real ask reaches the page, and a steer test for the pinned line.
