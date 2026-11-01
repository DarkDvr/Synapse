# Synapse v1.6.0

The renderer now measures alignment, so "it looks off" is a number a role has to fix.

## Added

- **A layout audit in `shot.mjs`**, run on every render, printed by `--audit` (which exits 1
  when there is anything to fix). Four checks, each one a defect the operator named by hand
  on their own mock:

  | check | what it catches |
  |---|---|
  | `controls-row` | a button 26px tall beside one 30px — the tops or heights differ by ≥2px |
  | `control-label` | a label more than 1px off its control's centre, in x or y |
  | `baseline` | two same-size runs on one line, ≥0.6px apart — the "182.0 MB / Open page" step |
  | `column` | a block whose rows start 2–40px apart — the header with an extra margin |

  On the operator's mock (`f4-modlist/.synapse/design/mock-1.html`) it reports exactly the three
  defects they had photographed and none of the four false positives the first attempt produced.

- **The briefs say what to do with it.** The Designer must read the audit before it reports, the
  Coder must run it on the page it built, and QC reads it as part of "design flaws". A finding is
  not a style opinion.

## Notes

- No dependency, no Playwright: the audit is one pass inside the page the renderer already loads
  (`getBoundingClientRect`, `Range` boxes, and an inline-block probe for the baseline).
- The report's existing fields are unchanged; `layout` is added to it, so anything reading the
  JSON keeps working.
- Full suite: 313 tests, including a fixture page with all four defects and a clean page that
  must report nothing.
