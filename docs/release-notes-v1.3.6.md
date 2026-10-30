# Synapse v1.3.6

An answered permission card now says so, and the click that wakes the window can
no longer answer one.

## Fixed

- **A click that brings Synapse forward no longer answers a permission.** On
  Windows, clicking an unfocused window focuses it *and* delivers the click to the
  page. If a waiting card happened to be under the pointer, one press could answer
  a request nobody had read — the card "disappeared before I could answer" in
  Test3, and the log showed an Always Allow had been sent one second before the
  Stop. A permission button now ignores a click that arrives within 400 ms of the
  window gaining focus, says why, and leaves the card up for the next click.
- **Every operator answer is in the log.** The gate logged what the policy decided;
  the operator's own answers had no line at all, so an answered card and a card
  that vanished looked the same. Each answer is now logged with the page that sent
  it, the button (Allow Once, Always Allow, Reject), the role and what it asked
  for — and a second view answering an already-settled card says so.

## Notes

- Full auto was not involved: with it off, a card waits for the operator, and a
  timeout (full auto only) answers `once` and logs `permission timed out`.
- Full suite: 274 tests, plus four new checks in the permission-reason test.
