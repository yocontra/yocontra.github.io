# Colyseus Cloudflare integration

Out West uses [Colyseus Cloudflare](https://github.com/yocontra/colyseus-cloudflare)
for its room transport, admissions, seat reservations, clock, and headless physics.
The library contains the generated Ammo factory, compiled modules, and upstream
notices.

Until the package is on npm, the repository installs
`vendor/colyseus-cloudflare-0.1.0.tgz`. It was packed from
[15362cb](https://github.com/yocontra/colyseus-cloudflare/commit/15362cbc1034b9350804ff722ec9926d216cb2ac)
with SHA-256 `9a5a957c53f2ef5aab6fdd5e3526f16b7e39cde3d1b4ebcb4ecf11f1fe698e42`.
To refresh the tarball, run `npm ci` and `npm pack` in the library checkout,
copy the result into `vendor/`, and run `bun install` here.

Run `bun api/src/game/generate-physics.ts` from the repository root after updating
the library. It copies the installed Ammo binary to the browser asset path.
The Workerd physics test checks that browser prediction and the server use
identical Ammo binaries.

The SQLite LobbyDirectory owns global admission, assignment and room routing. Colyseus's
LocalPresence and LocalDriver only index rooms inside their current isolate. A request resolves
its Durable Object owner before it reserves or consumes a seat. A room restart invalidates
transient seats and state. Clients obtain fresh authenticated tickets. Pending economic
settlements persist and retry with the original idempotency keys.
