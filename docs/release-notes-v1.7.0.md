# Synapse v1.7.0

The renderer can now compare a build with the mock that was approved for it, so "the build
does not look like the mock" is a percentage and a list of places.

## Added

- **`--diff MOCK.png` in `shot.mjs`.** It renders the build at exactly the mock's pixel size
  (the size is read from the PNG header, no decoder), compares the two pictures pixel by
  pixel, and prints the percentage plus the rectangles where they disagree, largest first.
  It writes `<name>-<width>-diff.png`: the build as a ghost with the changed pixels in red,
  at the mock's exact size, so the mock and the diff can be flipped between.
- **`--fail-over PCT`** turns the number into a gate (exit 1 when more differs), for
  comparing the same screen across builds, where any drift is a regression.
- **`--diff-threshold N`** (default 16) is how far a channel may move before a pixel counts.
- **QC's brief says what to do with it**: when a mock was approved, render the build at the
  mock's size, run the diff, quote the percentage and name the regions — and say which
  differences are drift and which are content the mock could not know.
- **Three tests**, one of them a regression for a trap this feature set on itself: the
  build's render was first written to `<base>-<width>.png`, which is exactly the name a mock
  shot by this same tool has. It overwrote the reference and compared the page with itself —
  0% on any change, and it looked like a clean bill of health. The build now writes
  `-build.png`, and the test asserts the mock's bytes are unchanged.

## Notes

- Refused before a browser starts: a mock that is not there, a file that is not a PNG, and a
  `--widths` that disagrees with the mock's size — two pictures taken at different widths
  compare two layouts, which is not the question being asked.
- A diff says where the pictures disagree; it cannot say which is right. Wording, hierarchy
  and whether a control belongs stay with the reviewer, and the skill text says so.
- Full suite: 316 tests.
