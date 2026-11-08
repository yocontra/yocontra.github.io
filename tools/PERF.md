# Out West native performance evidence

The target is at least 30 FPS sustained on an iPhone 13 mini, including a full 32-player town.
Use the iPhone 13 mini simulator and Safari as the requested acceptance and regression surface.
Record its host GPU and simulator/iOS versions: simulator results describe that environment,
not guaranteed A15 performance, memory pressure or thermal behavior. Desktop Chromium with
CPU throttling remains a separate regression proxy.

The 2026-11-08 interim production-mode Safari checkpoint used the release engine on the simulator's
Apple GPU at an 812×265 canvas and resolution scale 1. Ordinary remote play (one human and four bots)
measured a median 22.98 FPS and 299 draws; the explicitly synthetic 32-rider fixture measured 15.37 FPS
and 430 draws. Turning its HUD off did not improve performance. These short samples do not meet the
30 FPS target, and performance work remains open. They preceded the final vest/mount artifact refresh;
retain their exact source/content hashes with the raw measurements before comparing another build.
Development builds resolve PlayCanvas's debug engine and are diagnostic evidence, so acceptance
measurements must use a production build with the release engine.

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

In the iPhone 13 mini simulator, verify the production build at the requested resolution. Record
the build/content revision, simulator/iOS/Safari version, host GPU, orientation and canvas size.
Play a full Duel run through all four arenas, then at least fifteen minutes in a packed town,
including indoor fights, stairs/roofs, repeated deaths, respawns, dynamite and camera turns.
Collect sustained FPS and frame times after warming, memory growth, visible quality, touch
latency. Repeat disconnect/reconnect and background/foreground. Profile packed remote play and
local practice separately: the authoritative server runs the remote town's AI and physics, while
loopback runs them on the simulator. Keep both results visible. Older Three-renderer benchmark
tables were removed because they do not describe the native engine.

Before the visual restoration, the packed 32-rider Chromium regression ran near 60 FPS on this
development Mac, with a lowest rolling one-second rate of about 53 FPS while firing and simulating
four jointed corpses (40 native bodies). The packed street camera used roughly 350–400 visible
draw calls, including independently breakable panes; movement and native frustum culling lowered
that count. These are historical desktop observations, not current simulator acceptance evidence.
Repeat measurements on the final build/content revision after changes.

The test-only authoritative packed fixture keeps bot AI and full-town physics on the actual local
Worker while the browser predicts its own rider. Its 31 bots are synthetic load; production online
and ordinary local practice cap actual bots at four. Keep its result separate from the 32-human
capacity target and from loopback stress, which runs every bot and native motor on the client.

For the real local auth/D1/DO browser fixture, use:

```sh
OW_ORIGIN=http://localhost:4390 OW_API=http://127.0.0.1:8792 bun tools/test-playcanvas-frontier.ts
```

This optional mode uses ordinary signed account tokens and Turnstile, verifies that input moves
the authoritative pose and increments confirmed shots, then closes the socket and checks a
fresh authenticated connection resumes state. The seed endpoint exists only in the unshipped
test fixture. The harness does not print account tokens or signed WebSocket tickets.

The pre-restoration desktop lifetime soak completed 900.3 active simulation seconds (917.4 wall
seconds), crossing three practice rounds through the real Ride again button. It retained 32 riders
and at most 40 active corpse bodies, with no page errors and a lowest rolling one-second rate of
53.21 FPS. Natural garbage collection returned the JS heap to roughly 92 MB after a 248 MB peak;
the final sample was 126 MB. Unmount left zero players, corpse bodies and canvases. These measurements
cover desktop lifecycle and memory regression; they do not establish device memory/GPU limits.
They do not measure the repaired materials, vegetation, ambient life or lighting; repeat the
packed-scene measurement on the final repaired build before using it as current performance evidence.

```sh
OW_ORIGIN=http://localhost:4390 OW_SOAK_SECONDS=900 bun tools/soak-playcanvas-frontier.ts
OW_ORIGIN=http://localhost:4390 bun tools/test-playcanvas-actor-recovery.ts
```

The soak counts actual20Hzsimulationticks, so round-summary pauses cannot count toward the
required active duration. Its JSON, screenshots and final disposal counts are written to
`/tmp/out-west-native-soak/`. The actor regression aborts realGLBrequests, verifies native
HTTP retry exhaustion and visible cached fallback, then uses the actual Retry button and
unmounts during a subsequent pending load.
