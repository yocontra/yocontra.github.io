# Durable Game Runtime

Run a Colyseus room and authoritative Bullet physics inside a Cloudflare Durable Object.
Out West uses the same transport and physics code in production and uses the same Ammo build
for browser prediction.

- `durable-game-runtime/worker-physics` loads the compiled Ammo and callback modules in Wrangler.
- `durable-game-runtime/physics` creates a headless PlayCanvas application and its Bullet world.
  Add entities and rigid bodies to that application. Call `physics.step(seconds)` on fixed steps.
  Call `app.destroy()` when the room ends.
- `durable-game-runtime/transport` adapts a Durable Object WebSocket to a Colyseus server client.
  Call `dispatch` on binary input and `disconnected` on close. The host owns room routing and
  authenticates players before joining them.
- `durable-game-runtime/clock` gives Colyseus a fixed-step clock that advances in Workers timer
  callbacks even when the host clock has no new I/O to observe. Match `stepMs` to the room tick.
- `durable-game-runtime/client` can batch two native reliable input packets in one WebSocket
  frame. Dispose the batcher on leave. Other Colyseus packets pass through unchanged.
- `durable-game-runtime/ammo` loads Ammo from a compiled module or a URL in normal JavaScript
  runtimes. Serve the file exported as `durable-game-runtime/ammo.wasm` for browser prediction.

The package emits ESM and TypeScript declarations. It uses the pinned Colyseus and PlayCanvas
versions in `package.json`. Use Node 24 for package build scripts and `nodejs_compat` in Wrangler.
Run `npm pack` in this directory to build an installable tarball. Third-party attribution is in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Workers Free

Use a SQLite-backed Durable Object class and a `new_sqlite_classes` migration. Allocate physics
and start the timer when a player joins. Stop the timer and destroy the world when the room empties.
A live timer keeps the object active, so occupied rooms consume duration allowance. Check both
request and duration usage on the account. The quota is shared across applications.
[Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

This is an extraction candidate. Package metadata keeps it private pending the project's
license decision and publication.
