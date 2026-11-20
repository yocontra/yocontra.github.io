# Colyseus Cloudflare integration

Out West uses [Colyseus Cloudflare](https://github.com/yocontra/colyseus-cloudflare)
for its room transport, admissions, seat reservations, clock, and headless physics.
The library contains the generated Ammo factory, compiled modules, and upstream
notices.

Install the version pinned in `package.json` with `bun install`. The dependency
comes from the [npm registry](https://www.npmjs.com/package/colyseus-cloudflare).

Run `bun api/src/game/generate-physics.ts` from the repository root after updating
the library. It copies the installed Ammo binary to the browser asset path.
The Workerd physics test checks that browser prediction and the server use
identical Ammo binaries.

The SQLite LobbyDirectory owns global admission, assignment and room routing. Colyseus's
LocalPresence and LocalDriver only index rooms inside their current isolate. A request resolves
its Durable Object owner before it reserves or consumes a seat. A room restart invalidates
transient seats and state. Clients obtain fresh authenticated tickets. Pending economic
settlements persist and retry with the original idempotency keys.
