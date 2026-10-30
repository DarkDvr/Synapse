# Synapse v1.3.8

A steer now carries the same bright yellow rule as the permission log, and after
a Stop the Architect is told the run ended instead of waiting for a report that
will never arrive.

## Fixed

- **The steer line's own rule.** A steer in a run's trace is marked by the same
  2px bright yellow rule the permission log uses in the chat. It is drawn over the
  trace's grey rule — the line reaches back 12px over the trace's border and
  padding — so there is one rule that turns yellow where the operator spoke,
  rather than a second bar beside it.
- **A stopped run stops looking "in flight".** A stop produces no report, by
  design, so the Architect's conversation still ended on its delegate call. In
  test5 the operator stopped t4's designer run, typed "continue work", and got
  "t4's resend hasn't reported back yet" beside a plan with three todo rows. The
  brief now states the fact from the ledger — the last run ended without a report,
  nothing has started since, the row is back in todo — and tells the Architect not
  to wait for it. It never says why the run stopped: that part was, and stays, the
  operator's to say.

## Notes

- Full suite: 282 tests, including the brief line and its disappearance once a new
  delegation is in the ledger.
