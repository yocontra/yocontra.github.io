# Out West native performance evidence

The target is at least 30 FPS sustained on a physical iPhone 13 mini, including a full 32-player
town. Desktop Chromium with CPU throttling is a regression proxy. It cannot reproduce an A15
GPU, iOS Safari scheduling, memory pressure or heat, and cannot certify the physical target.

Use the native engine metrics and actual production mount paths:

```sh
bun tools/test-playcanvas-duel.ts http://localhost:4389
OW_ORIGIN=http://localhost:4389 bun tools/test-playcanvas-frontier.ts
bun tools/playcanvas-perf.ts http://localhost:4389 --rate=4 --seconds=30
```

The Frontier regression creates 32 riders, exercises native input/combat and bounded Ammo corpse
lifecycles, and checks respawn and unmount. The performance tool creates the same packed local
town at 375×812 CSS pixels with DPR 3 and CPU throttling, then records frame interval p50/p95/p99,
native draw calls, actual player count, resolution scale, FPS and ragdoll counts. It saves JSON
and a screenshot to `/tmp/out-west-native-performance.*`. Use `--rate=1` for an unthrottled
baseline and longer runs for leak/adaptation checks. Initial asset loading is excluded. Measurement begins when controls are enabled and the scene
is playable; all subsequent stalls, including first-shot shader work, remain in the result.

The PlayCanvas application uses native PBR with an HDR environment atlas, one shadowed sun,
bounded resolution adaptation and native skeletal Anim components. Models and outfits are
prebaked GLBs. Native Ammo runs fixed-step authoritative collision, and cosmetic corpse physics
has an explicit active-body cap before actors freeze into a native pose.

On an iPhone 13 mini, verify the production build at the actual device resolution. Record the
build/content revision, iOS/Safari version, orientation, power mode and starting temperature.
Play a full Duel run through all four arenas, then at least fifteen minutes in a packed town,
including indoor fights, stairs/roofs, repeated deaths, respawns, dynamite and camera turns.
Collect sustained FPS and frame times after warming, memory growth, visible quality, touch
latency and any thermal deterioration. Repeat disconnect/reconnect and background/foreground.
The required evidence is the measured physical run; older Three-renderer benchmark tables were
removed because they do not describe the native engine.

The actual packed32 Chromium regression currently runs near60FPS on this development Mac,
with a lowest rolling one-second rate of about53FPS while firing and simulating four jointed
corpses (40native bodies). The packed street camera uses roughly350–400visible draw calls,
including independently breakable panes; movement and native frustum culling lower that count. These are desktop observations, not an iPhone13mini result. The physical minimum
remains unverified. Repeat measurements on the final build/content revision after changes.

For the real local auth/D1/DO browser fixture, use:

```sh
OW_ORIGIN=http://localhost:4390 OW_API=http://127.0.0.1:8792 bun tools/test-playcanvas-frontier.ts
```

This optional mode uses ordinary signed account tokens and Turnstile, verifies that input moves
the authoritative pose and increments confirmed shots, then closes the socket and checks a
fresh authenticated connection resumes state. The seed endpoint exists only in the unshipped
test fixture. The harness does not print account tokens or signed WebSocket tickets.

The desktop lifetime soak completed900.3active simulation seconds (917.4wall seconds), crossing
three practice rounds through the real Ride again button. It retained32riders and at most40
active corpse bodies, with no page errors and a lowest rolling one-second rate of53.21FPS.
Natural garbage collection returned the JS heap to roughly92MB after a248MB peak; the final
sample was126MB. Unmount left zero players, corpse bodies and canvases. These measurements
cover desktop lifecycle and memory regression; they do not establish device memory/GPU limits.

```sh
OW_ORIGIN=http://localhost:4390 OW_SOAK_SECONDS=900 bun tools/soak-playcanvas-frontier.ts
OW_ORIGIN=http://localhost:4390 bun tools/test-playcanvas-actor-recovery.ts
```

The soak counts actual20Hzsimulationticks, so round-summary pauses cannot count toward the
required active duration. Its JSON, screenshots and final disposal counts are written to
`/tmp/out-west-native-soak/`. The actor regression aborts realGLBrequests, verifies native
HTTP retry exhaustion and visible cached fallback, then uses the actual Retry button and
unmounts during a subsequent pending load.
