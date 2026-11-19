# Generated Ammo integration

The headless physics and Cloudflare transport live in
[`packages/durable-game-runtime`](../../../../../packages/durable-game-runtime).
The package keeps the generated Ammo factory, compiled modules, and upstream notices together.
Out West serves the same Ammo binary at `/experiments/out-west/physics/ammo.wasm.wasm`.

Run `bun api/src/game/generate-physics.ts` from the repository root to regenerate both copies.

The SQLite LobbyDirectory owns global admission, assignment and room routing. Colyseus's
LocalPresence and LocalDriver only index rooms inside their current isolate. A request resolves
its Durable Object owner before it reserves or consumes a seat. A room restart invalidates
transient seats and state. Clients obtain fresh authenticated tickets. Pending economic
settlements persist and retry with the original idempotency keys.
