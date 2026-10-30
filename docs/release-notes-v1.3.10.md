# Synapse v1.3.10

The Architect's own retry wait now ends when you change its model, exactly as a
worker's does.

## Fixed

- **The Architect's backoff is woken too.** v1.3.9 ended a worker run's provider
  wait when its role's model changed; the Architect has its own retry loop for
  sending a report, and it kept sleeping. Changing the Architect's model (in the
  picker or Settings) now:
  - ends that wait,
  - moves the chat's session to the new model (ref **and** variant),
  - clears the red "Retrying at …" line, and
  - retries the report at once.

  Its usage-cap timer starts fresh, because the cap belongs to the model that is
  gone.

## Notes

- Both paths are a wake, not a stop: a working turn is untouched, and only a wait
  that is actually in progress is ended.
- Full suite: 285 tests.
