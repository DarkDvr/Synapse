# Synapse v1.1.2

A licence, and a cleaner transcript.

## Licence

Synapse is now **AGPL-3.0-only**. Copyright (C) 2026 DarkDvr.

- `LICENSE` is the full GNU Affero General Public License v3.
- `NOTICE` carries the copyright and the "keep this notice, say if you modified
  it" line.
- `THIRD-PARTY.md` lists what travels with Synapse and under which licence:
  OpenCode and Node (MIT), DM Sans and Manrope (SIL OFL 1.1), with their licence
  files in the folder.
- `package.json` declares `AGPL-3.0-only`, the author, and the repository.
- Settings → About shows the licence and a link to the source.

The AGPL was chosen because it keeps the work free and open: a copy or a
network-served modified version must keep the notices and offer its source under
the same licence. A fork cannot quietly present itself as the original Synapse.

## The answer gets its own line

The final reply in a transcript now has a quiet green rule down its left, with a
little more space above it. The reasoning blocks and tool cards above stay on the
plain background. Narration inside a step that also calls a tool stays plain too
— that is work, not the answer. Long replies read as one column instead of
another grey block.

## Notes

- Full suite: 251 tests.
- The update asset for this release is `Synapse-1.1.2-win-x64.zip` with
  `SHA256SUMS`; the updater on an existing install can take it from here.
