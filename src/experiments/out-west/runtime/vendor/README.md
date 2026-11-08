# Generated Ammo integration

`ammo-factory.ts` and the public `ammo.wasm.wasm` originate from
[PlayCanvas engine v2.23.3](https://github.com/playcanvas/engine/tree/v2.23.3/examples/assets/wasm/ammo).
Ammo is the Bullet port by the ammo.js contributors, distributed under the zlib license
in `AMMO-LICENSE.txt`; `PLAYCANVAS-LICENSE.txt` retains the engine's MIT notice.
The generated factory is altered source, not authored game code. It alone is excluded from
Biome's authored-code rules. The maintained loader, motor, transport and generator are checked.

Reproduce the pinned assets from the repository root:

```sh
bun api/src/game/generate-physics.ts
```

The generator forces the web environment, converts the CommonJS footer to ESM, and lets
`addFunction` instantiate a precompiled callback trampoline. Node and browsers can compile
Ammo normally. Cloudflare Workers require Wrangler's compiled Wasm module imports; they cannot
compile the tiny callback wrapper dynamically. `api/src/game/physics-callback.wasm` imports
`e.f(i32,f32)->void` and exports `f`, matching the engine's internal tick callback.
Every callback gets a separate instance; Ammo owns function-table allocation and removal.
Worlds share the Ammo module, while each AppBase owns its AmmoPhysicsWorld. Destroying one
world must never destroy a different room's callback or bodies.

The native adapter uses the official Colyseus `Client`, `ClientPrivate`, `enqueueClientRaw`
and message encoders. Community feasibility research consulted
[c-py at b0f296e](https://github.com/c-py/colyseus-cloudflare-worker-transport/tree/b0f296e444867dc2edb47e351c28b7238e08289f).
That repository declares `UNLICENSED`; its code is not vendored or incorporated. This project
implements DO-owned sockets and timer-driven delivery independently, and does not use its
recipient-input send queue or custom Presence/Driver.

The SQLite LobbyDirectory owns global admission, assignment and room routing. Colyseus's
LocalPresence/LocalDriver only index rooms inside their current isolate. A request resolves its
DO owner before reserving or consuming a seat; an isolate registry is never queried as a global
matchmaking database. A room/process restart invalidates its transient seats and state; clients
obtain fresh authenticated tickets. Pending economic settlements are stored durably and retried
idempotently. Live carry and physics state are intentionally memory-only, as before.
