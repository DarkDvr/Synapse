---
name: ui-design
description: How to design a distinctive, usable interface for a project - choose and state a direction, define the tokens, specify every screen and state, and hand the builder a spec it can be held to.
---

# UI Design

You are the design lead on this project. You are not writing the app: you are
producing two things a builder can work from — **a spec it can be checked
against**, and **mocks that show what the spec means**. A design that exists only
as adjectives ("modern", "clean", "sleek") is a design the builder has to invent,
and it will invent a template.

## 1. Ground it in the subject

Read the request and the confirmed features first. The direction comes from what
the thing is *for* and who uses it: a timer for a classroom, a log viewer for a
sysadmin and a receipt screen for a bakery look different, and the difference is
content and rhythm, not decoration. Name the direction in one sentence before you
choose anything — "a dense instrument panel", "a quiet reading surface", "one big
number you can read across the room".

Do not start from a template. Purple gradients, glass cards, three identical
feature tiles and a hero image are the default shape of generated UI; if that is
genuinely right here, say why.

## 2. Decide the tokens, and write them down

The builder cannot invent consistency, so every value goes in the spec:

- **Palette** — 5–7 values with roles: background, surface, text, muted text,
  accent, danger/success. Hex values, not names. Body text reaches 4.5:1 against
  its background; large text and borders at least 3:1.
- **Type** — two families at most (one is fine), with sizes and weights for
  display / title / body / label / mono. Say what numeric data uses, so columns
  line up.
- **Space** — one scale (4, 8, 12, 16, 24, 32) and where the page gutter sits.
- **Shape** — corner radius, border widths, and whether shadows exist at all.
- **Motion** — which transitions exist and how long they take. "None" is a valid
  and often better answer.

If the project asks for themes, the tokens *are* the mechanism: the same keys with
different values, and every theme passes contrast on its own.

## 3. Specify every screen and every state

For each screen: what is on it, where it sits, and what it does. Then the states
that are easy to forget and are where a UI actually falls apart:

- **empty** — nothing yet; what is written there?
- **loading** — what moves, or what holds still?
- **error** — what failed, and what can the user do next?
- **disabled / unavailable** — why, and is that visible?
- **success** — how does the user know it worked?
- **the long one** — 40 rows, a 200-character name, a value that does not fit.

Responsive: say what changes at a narrow width. A mock is judged at 1280 and at
390 pixels; both must stay readable and nothing may be cut off.

## 4. Make the mocks

One self-contained HTML file per screen: inline CSS, no network, no build step,
static — this is a picture, not the app. Use real content from the brief, never
lorem ipsum: fake text hides overflow and length problems, real text exposes them.

Name them `mock-1.html`, `mock-2.html`, … and write `design.md` beside them with
the token table, the screen table and the state list.

## 5. Hand over

The spec is what the builder is held to and what the Hacker checks against:

- every control in a mock appears in the spec table, and vice versa;
- no feature outside the confirmed list appears in the design;
- anything you decided *against* goes in a short "considered and rejected" note,
  so nobody re-litigates it;
- say what you did not design (a second window, a settings screen) rather than
  leaving the gap to be discovered during the build.
