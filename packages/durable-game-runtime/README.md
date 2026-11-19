# Durable Game Runtime

Run a Colyseus room and authoritative Bullet physics inside a Cloudflare Durable Object.
Out West uses the same transport and physics code in production. Browser prediction loads the same Ammo binary.

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

This is an extraction candidate. Package metadata keeps it private pending the project's
license decision and publication.

## Run the standalone example

From the package source directory, build and install the tarball with Node 24 and npm.

```sh
npm install --ignore-scripts --no-package-lock
npm pack --dry-run
npm pack --pack-destination example
cd example
npm install --ignore-scripts --no-package-lock
npm run check
npm run bundle
npm run dev
```

From a second terminal in `example/`, run `npm run smoke`. The smoke opens three Colyseus
clients across two Durable Objects. Both players in the first room see the other box fall.
One player sends a hop command and the other receives its new position. The second room
keeps running after the first empties and releases its world. The reservation check verifies
that the first seat allocates no physics.

The example installs from the tarball and uses registry PlayCanvas without the Out West patches.
It has no production bindings or accounts. The demo accepts local player names. Authenticate
players and derive their identities on the server before exposing a public endpoint.

## Admission and room lifetime

Use SQLite-backed Durable Objects with a `new_sqlite_classes` migration on Workers Free.

- `durable-game-runtime/seats` stores short-lived Colyseus seat metadata in a SQLite-backed
  Durable Object. Seat consumption checks the authenticated account and room and deletes the
  seat atomically. The caller schedules an alarm for `nextExpiry()` and calls `expire()` on wake.
- `durable-game-runtime/admission` implements a shared daily allowance for active room time
  and inbound frames. Store the ledger in a single SQLite-backed Durable Object, grant and renew
  a lease independently for each live room, and release it with the final count. A vanished room's
  reserved quota stays charged for the day. Close a room if its lease fails to renew.
- Route requests to the owning Durable Object before using Colyseus's LocalDriver.
  Each room owns its own Bullet world. Use an authenticated seat again after an isolate restart.
  In-memory physics and pending sockets cannot restore a match on their own.

Cloudflare's published Free allowance for Durable Objects is 100,000 billed requests and
13,000 GB-s of duration per day. Incoming WebSocket messages count at 20:1 toward Durable
Object request billing. That ratio does not apply to the separate Worker request limit.
At the documented 0.125 GB-s per active object-second, the duration allowance equates to
about 104,000 active room-seconds per day before other account usage. A room with a live timer uses
duration even when its sockets are quiet. The package and local example exercise the runtime
and room lifecycle. Production capacity depends on traffic, match duration, physics work, and
other usage on your account.
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
