# Third-Party Notices

This project embeds and depends on third-party software. The notes below record
what is bundled and how this project satisfies the corresponding license terms.

## Giac / Xcas — GPL-3.0-or-later

- **Component:** `src/server/giac/giac.wasm.js` (and its embedded `.wasm`
  payload), compiled from the [geogebra/giac](https://github.com/geogebra/giac)
  fork of Giac/Xcas by Bernard Parisse
  (https://xcas.univ-grenoble-alpes.fr/).
- **License:** GNU General Public License, version 3 or later (GPL-3.0+).
- **Copyright:** © Bernard Parisse and the Giac/Xcas contributors.
- **Build:** `scripts/build-giac-wasm.sh` → `docker/build-giac-wasm/`
  (`GIAC_REF` selects the upstream ref). The build is fully reproducible from
  upstream sources; no patches are applied to Giac itself.

### Compliance

Axiom links Giac into a combined work. Under GPL-3.0 this obliges the combined
work to be distributed under GPL-3.0-compatible terms, so **this entire project
is licensed GPL-3.0-or-later** — see [LICENSE](LICENSE).

The corresponding source for every part of the distributed work is publicly
available at https://github.com/tufantunc/axiom-advanced-math-mcp, which
satisfies the source-availability requirement of GPL-3.0 §6. Giac's own
corresponding source is available from the upstream repository above.

### What this means for you

- **Running Axiom, including as a service, is unrestricted.** The GPL places no
  conditions on use.
- **Calling Axiom from your own agent does not make your agent GPL.** Your agent
  and this server are separate programs communicating at arm's length over the
  Model Context Protocol (a separate process, over stdio or HTTP). That is not
  linking, and it does not create a combined work.
- **Redistributing Axiom — modified or not — requires GPL-3.0 terms.** Ship the
  source (or a written offer for it) alongside any binary or bundled copy you
  distribute, and keep this notice intact.
- **Embedding Giac in a proprietary product is not possible under this
  license.** That requires a separate commercial Giac license from the upstream
  author.

This file is a compliance record, not legal advice.

## Runtime dependencies

These are declared in `package.json` and installed from npm rather than vendored
into this repository. Their licenses are permissive and compatible with
GPL-3.0-or-later:

| Package                     | License    |
| --------------------------- | ---------- |
| `@hono/node-server`         | MIT        |
| `@modelcontextprotocol/sdk` | MIT        |
| `hono`                      | MIT        |
| `mathjs`                    | Apache-2.0 |
| `zod`                       | MIT        |

Full license texts ship inside each package under `node_modules/`.
