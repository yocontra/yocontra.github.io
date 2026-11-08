# contra.io

Eric Schoffstall's site: a static Astro build for GitHub Pages, a Cloudflare Worker API, and the
`out-west` games.

## Quick start

```bash
# Node >=22.23.4 (or Node26) and Bun1.3.14
bun install
bun dev                  # http://localhost:4321
```

The API runs on Cloudflare Workers Free with D1 and SQLite Durable Objects. Frontier rooms use
Colyseus0.18 and the same native PlayCanvas/Ammo movement on the server and client:

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

| Path                                 | What                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/pages/`                         | Site routes, including `/experiments/*`                                                                                                    |
| `src/components/`, `src/layouts/`    | The portfolio site                                                                                                                         |
| `src/experiments/out-west/`          | PlayCanvas games: `duel/` directors, `client/` native rendering/input/HUD, `runtime/` shared Ammo and SDK schemas, `ffa/sim/` domain rules |
| `src/experiments/out-west/data/`     | Roster, economy, catalogue, tuning — shared by client and server                                                                           |
| `src/experiments/out-west/contract/` | Wire types and protocol constants                                                                                                          |
| `api/`                               | Cloudflare Worker: auth, ranked, Daily, Frontier lobbies, D1 + Durable Objects                                                             |
| `tests/`                             | Client tests (DOM allowed)                                                                                                                 |
| `tools/`                             | Asset pipeline, audits and perf harnesses; see `tools/README.md`                                                                           |

Tuning and domain rules are shared by client and server. PlayCanvas owns rendering, skeletal
animation, PBR lighting, sound components, rigid bodies and joints. Authored GLBs, equipment and
collision artifacts live in `content/` and `public/experiments/out-west/3d/`. Colyseus owns room
replication, prediction and reconciliation; signed account reservations retain the API's auth
and Turnstile checks. Practice runs the same native motor and game rules locally.

Native browser regressions run against the real game pages:

```bash
bun tools/test-playcanvas-duel.ts http://localhost:4321
OW_ORIGIN=http://localhost:4321 bun tools/test-playcanvas-frontier.ts
```

The Frontier harness exercises32 riders, firing, native movement, bounded corpse physics,
respawn and disposal. With `OW_API` pointed at the unshipped local API test fixture, it also
checks authenticated authoritative input and fresh-seat reconnect. See `tools/PERF.md` for
performance measurements and the physical iPhone13mini30FPS target.

## Deploy

Pushes to `master` deploy the site (`deploy.yml`) and, when `api/` or the shared sim changes, the
Worker (`deploy-api.yml`). Both run `bun run check`. See `RELEASE.md` for the one-time setup and
operations.
