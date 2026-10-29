# Third-party work

Synapse's own code is licensed under AGPL-3.0-only (see `LICENSE` and `NOTICE`).
These components travel with it and keep their own licences.

| Component | Licence | Where |
|---|---|---|
| OpenCode 2.1.2 | MIT, Copyright (c) 2025 opencode | `bin\opencode\LICENSE` |
| Node.js 24.21.0 | MIT, with its bundled third-party notices | `bin\node\LICENSE` |
| DM Sans | SIL Open Font License 1.1 | `web\vendor\fonts\OFL-DMSans.txt` |
| Manrope | SIL Open Font License 1.1 | `web\vendor\fonts\OFL-Manrope.txt` |

The font files are served locally by `web\vendor\fonts.css`; nothing is fetched
from a font CDN. The engine and Node licences travel with their binaries.

Synapse's MIT/AGPL combination is compatible: the MIT components permit
distribution under the AGPL, and their notices remain in place.
