# contra.io

Eric Schoffstall's site: a static Astro build for GitHub Pages, a Cloudflare Worker API, and the
`out-west` games.

## Quick start

```bash
bun install
bun dev                  # http://localhost:4321
```

The API is a separate Worker (only the games need it):

```bash
bun run api:dev          # http://localhost:8787
bun run api:migrate:local
```

## Checks

```bash
bun run check            # biome + typecheck + tests + debt ratchets + no-js
bun run test             # API and client tests
bun run typecheck        # astro check + every tsconfig project
bun run fix              # biome check --write
bun run build            # static build into dist/
```

`bun run check` is the gate CI runs. A pre-push hook runs it too; enable once per clone:

```bash
git config core.hooksPath .githooks
```

The ratchets in `scripts/` keep the debt visible:

- `lint-debt.ts` caps the number of Biome suppressions.
- `debt-audit.ts` caps cross-boundary duplicated constants, name-based scene classification and
  `as unknown as` in shipping source. Lower a baseline in the same commit that fixes one.

## Layout

| Path                                 | What                                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/pages/`                         | Site routes, including `/experiments/*`                                                                                           |
| `src/components/`, `src/layouts/`    | The portfolio site                                                                                                                |
| `src/experiments/out-west/`          | The games: `duel/` (standoff), `ffa/` (Frontier), `scene/` (three.js), `ffa/sim/` (pure deterministic sim shared with the server) |
| `src/experiments/out-west/data/`     | Roster, economy, catalogue, tuning — shared by client and server                                                                  |
| `src/experiments/out-west/contract/` | Wire types and protocol constants                                                                                                 |
| `api/`                               | Cloudflare Worker: auth, ranked, Daily, Frontier lobbies, D1 + Durable Objects                                                    |
| `tests/`                             | Client tests (DOM allowed)                                                                                                        |
| `tools/`                             | Asset pipeline, audits and perf harnesses; see `tools/README.md`                                                                  |
| `docs/`                              | Design decisions (e.g. the engine plan)                                                                                           |

Tuning lives in the client data modules and the server imports them; a judged number has one
source. Scene objects and materials carry `userData.role` / `userData.slot` (`scene/roles.ts`)
instead of being recognised by name.

## Deploy

Pushes to `master` deploy the site (`deploy.yml`) and, when `api/` or the shared sim changes, the
Worker (`deploy-api.yml`). Both run `bun run check`. See `RELEASE.md` for the one-time setup and
operations.
