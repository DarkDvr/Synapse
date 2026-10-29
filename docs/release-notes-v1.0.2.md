# Synapse v1.0.2

The version is now visible in the places a person looks for it, and there is an
About page.

## Added

- **Settings → About.** The mark, the running version, one line on what Synapse
  is, the author (DarkDvr), the contact address and the licence — a short page,
  not a form. Save and Revert are hidden there because there is nothing to save.

## Fixed

- **The title bar said v0.1 forever.** The badge was typed into the window's XAML.
  It is now read from `package.json` beside the exe — the same file the server
  reads — so it follows every release without a second edit. The window title
  shows the version too.

## Notes

- The version in the title bar, the status rail and About all come from one
  number: `package.json` → `version`. The shell's `<Version>` mirrors it for the
  exe's file properties.
- Full suite: 247 tests.
