# Synapse v1.1.1

Two fixes inside the updater itself.

## Fixed

- **The downloaded zip keeps the release's own file name.** `SHA256SUMS` lists
  `Synapse-<version>-win-x64.zip`; saving the download as `<version>.zip` meant
  the checksum could never be matched when GitHub did not supply an asset digest.
  It is now saved under the asset name, and the checksum matches.
- **A failed release check is retried at the next start.** The boot check caches
  a successful answer for six hours; it used to cache the failure too, so after
  making a private repository public the chip could stay dark until the cache
  aged out. Only a successful check is now cached with that grace; a failure is
  asked again on the next boot (and by Check Again).

## Notes

- Everything in v1.1.0 is here: the universal UPDATE chip, the two-card dialog
  with changelog and console, the program-files-only self-update, and popups that
  no longer close on an outside click.
- Full suite: 251 tests.
