# Out West full PlayCanvas rewrite

Approved by the user in this conversation. Implementation is unconditional: no engine or hosting selection gates.

## Requirements

- PlayCanvas native ECS, assets, animation, materials, lighting, input, audio, UI and Ammo physics; delete superseded custom systems.
- Colyseus 0.18 authoritative replication, input, prediction, reconciliation and lag compensation.
- Cloudflare Workers Free and SQLite Durable Objects only; zero dollars monthly hosting, no Containers or external game servers.
- Full 32-player Frontier; minimum 30 FPS on physical iPhone 13 mini in crowded sustained gameplay.
- Preserve Duel, Frontier, local practice, Daily, ranked, accounts, inventory, progression, economy, moderation and existing movement/combat abilities.
- Existing Bun/Astro/Wrangler and static delivery. Do not disrupt unrelated experiments or persistent player records.

## Task 1: Shared simulation and Cloudflare runtime

Owner: rewrite_server. Files: api/**, src/experiments/out-west/runtime/**, tests/runtime/**, package.json, bun.lock.

Implement room-owned PlayCanvas AppBase/NullGraphicsDevice physics, identical pinned Ammo build and collision data on server/browser, precompiled WASM import for Workers. 20 Hz game updates with three 60 Hz physics substeps; routine input batching at 10 Hz, bounded immediate discrete actions. A single scheduler owns physics. Shared input intent and replicated state include velocity and movement state; clients cannot authoritatively report damage, reward or position. Isolated local prediction; deduplicated effects/events. Versioned protocol/physics/collision manifest compatibility.

Implement the Cloudflare adapter independently using official Colyseus 0.18 APIs. The c-py integration at b0f296e444867dc2edb47e351c28b7238e08289f is a research reference only: its package declares UNLICENSED, so no community source is copied. Retain official dependency licenses and research provenance. Implement transport/presence/driver/room routing using DO RPC and managed sockets. Fix recipient-input-dependent sends, message-triggered patches, IPC leaks, implicit shared globals and SQLite declarations. Test concurrent rooms in one isolate. Dispose worlds and timers when rooms empty; hibernatable idle sockets. Persist idempotent economic settlement before acknowledgment. Rebuild logical room state on restart and send authoritative reset, not raw Ammo heap.

Replace paid monthly budget assumptions with UTC daily free budget accounting, ordinary gameplay limited to 80% with reserves for settlement/reconnect/shutdown. Account Worker/DO requests, duration, D1/DO reads/writes/storage and accounting overhead. Room usage leases bound admission and shutdown. Fill existing rooms, max four Frontier rooms; bots cannot keep rooms awake. Graceful online-unavailable messaging with local practice continuing. Voice off by default, included minutes only with enforceable reservation and timeout; recording/transcription disabled.

Success: meaningful real workerd tests prove WASM initialization, movement, autonomous replication, multiroom isolation, reconnect/disposal, settlement, lease exhaustion and UTC rollover. Existing player services preserved. No unapproved paid billing or production changes.

## Task 2: Browser game

Owner: rewrite_client. Files: src/experiments/out-west/** except runtime/** and content/**; src/pages/**; tests/client-playcanvas/**.

Use engine-native types and lifecycle, no custom ECS or engine abstraction. Rebuild all game modes and mechanics against Task 1 shared simulation. Native animation graphs with standardized clips, PBR, IBL, lightmaps, restrained dynamic shadows, instancing/LOD, compressed mipmapped textures. WebGL2 launch baseline; measure WebGPU separately. Adaptive quality preserves match capacity, aiming, collision and legibility. Touch input/cameras/hitfeedback/weapon timing improve user experience. Preserve inventory, account UX and western identity.

Success: real runnable game across all existing modes and integrations, actual browser screenshots, automated meaningful integration tests, no silent feature loss. Delete replaced Three/Cannon/rendering/network/geometry/animation systems after consumers port. Remove dependencies only after checking other site experiments.

## Task 3: Content conversion

Owner: rewrite_assets. Files: tools/**, public/experiments/out-west/**, src/experiments/out-west/content/**, tests/content-playcanvas/**.

Create authored/prebaked GLBs, standardized skeletons/clips/modular equipment/material variants, simplified collision shapes and versioned visual/collision manifests. Reuse useful offline tools, glTF Transform and meshoptimizer. Move procedural generation offline only when useful; count all maintained tools/adapters in code reduction. Coordinate data interfaces with Tasks 1 and 2. Preserve current content and catalogue coverage, no toy substitute map.

Success: valid deterministic outputs used by browser and server, tests of artifact compatibility, content completeness and collision transforms. Asset loading failures are actionable.

## Integration and publication

Sequence foundation/runtime, playable systems, content/modes, deletion/integration, cutover. Run existing lint/type/test/build/debt checks; continuous simplification, correctness and performance review. Fix failures within committed stack. Verify physical iPhone 13 mini production build for 15 minutes, 32-player combat, >=30 FPS rolling active-gameplay windows, frame percentiles/hitches, memory and quality. Exercise loading, repeated matches, rotation/background, audio/touch, low-power and installed web app.

Before publication preserve accounts/inventory, drain old rooms and settle outstanding events, coordinate client/server protocol, invalidate stale caches, verify free Cloudflare configuration and publication. Never claim real-device QA from desktop emulation.

## Implementation ownership refinement

After content conversion, rewrite_assets additionally owns game.ts, duel/**, scene/**, main.ts, ui/** and tests/duel-playcanvas/** for full native Duel port. rewrite_client owns client/**, ffa/** and pages for full native Frontier port. Coordinate remaining legacy scene consumers before deletion. All original acceptance requirements remain in force.
