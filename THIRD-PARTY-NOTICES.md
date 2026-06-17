# Third-Party Notices

This project embeds third-party software. The notes below are an internal
record of what is bundled and the compliance posture chosen for it.

## Giac / Xcas — GPL-3.0-or-later

- **Component:** `src/server/giac/giac.wasm.js` (and its `.wasm` payload),
  compiled from the [geogebra/giac](https://github.com/geogebra/giac) fork of
  Giac/Xcas by Bernard Parisse (https://xcas.univ-grenoble-alpes.fr/).
- **License:** GNU General Public License, version 3 or later (GPL-3.0+).
- **Build:** `scripts/build-giac-wasm.sh` → `docker/build-giac-wasm/`
  (`GIAC_REF` selects the upstream ref).

### Compliance posture

This product is distributed **only as a hosted service** (private repository;
customers reach it over an API and never receive the software). Under GPL-3.0,
running the software to provide a network service is **not** "conveying"
(distribution), so the source-disclosure obligation is not triggered for API
users. This is the GPL "SaaS/ASP" boundary — note it would be closed by the
AGPL, but Giac is GPL-3.0, not AGPL.

**Load-bearing constraint — do NOT, without a separate commercial Giac
license from the upstream author:**

- publish this package to npm or any public registry,
- make this repository public,
- ship an on-prem / self-hosted / downloadable build to any customer,
- distribute a demo build.

Each of those is "conveying" and would place the entire combined work under
GPL-3.0 for that copy. For any non-hosted model, obtain a commercial license
from Bernard Parisse first.

This file is an internal record, not legal advice. Confirm the commercial
posture with an IP attorney before relying on it.
