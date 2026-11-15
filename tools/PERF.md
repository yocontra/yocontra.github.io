# Out West native performance evidence

The target is at least 30 FPS sustained on an iPhone 13 mini, including a full 32-player town.
Use the iPhone 13 mini simulator and Safari as the requested acceptance and regression surface.
Record its host GPU and simulator/iOS versions: simulator results describe that environment,
not guaranteed A15 performance, memory pressure or thermal behavior. Desktop Chromium with
CPU throttling remains a separate regression proxy.

The 2026-11-08 interim production-mode Safari checkpoint used the release engine on the simulator's
Apple GPU at an 812×265 canvas and resolution scale 1. Ordinary remote play (one human and four bots)
measured a median 22.98 FPS and 299 draws; the explicitly synthetic 32-rider fixture measured 15.37 FPS
and 430 draws. Turning its HUD off did not improve performance. Host foreground/presentation state
was not verified, so these are diagnostics, not acceptance evidence. They preceded the final
vest/mount artifact refresh; retain their source/content hashes before comparing another build.
Development builds resolve PlayCanvas's debug engine and are diagnostic evidence, so acceptance
measurements must use a production build with the release engine.

A later minimal recorder measured 15.94 rAF/s over 30 seconds in the release-engine 32-rider scene
(p95 80 ms, p99 87 ms), versus 59.97 rAF/s in an empty DOM control. Safari reported visible/focused,
but the host's frontmost application was loginwindow. Separate WebGL clear and empty native-engine
controls reached about 60 rAF/s with different settled buffer dimensions. These observations do not
establish foreground acceptance or isolate a rendering bottleneck. The 30 FPS target remains open.

For acceptance, verify the actual device window and host foreground state before and after the run.
Xcode 27 uses DeviceHub; absence of the older Simulator.app process does not establish headless operation.
Record frozen source/content hashes, release-engine resolution, renderer, CSS and drawing-buffer
dimensions, DPR, resolution scale and native MSAA samples. Close competing jobs and inspector,
profiler, recorder and interaction-observer sessions. Use a minimal timestamp recorder during the
measurement; collect expensive counters separately. Compare the same camera, population, scene state
and adaptive-resolution policy. Preserve all stalls and report frame percentiles and the lowest
rolling one-second rate. Include at least 60 active seconds of movement, firing, death/respawn and
window break/reset before longer lifecycle runs.

For new foreground qualification, build and serve a frozen candidate with the local Worker:

```sh
bunx wrangler d1 migrations apply out-west-native-test --local --config api/test/wrangler.native-test.jsonc
bunx wrangler dev --local --config api/test/wrangler.native-test.jsonc --port 8798 --inspector-port 9258 --var 'ALLOWED_ORIGINS:http://127.0.0.1:4398'
bun tools/serve-production-recording.ts --port=4398 --api=http://127.0.0.1:8798
```

Wait for the production fixture URL, then use a separate terminal. Do not run overlapping Astro
builds in the same checkout: they share a prerender cache. Keep Chrome's actual recording window
frontmost for the entire run. The runner records its browser PID and requires the same process
in the macOS foreground trace, as well as visible/focused page state.
Host coverage must reach within one second of both recording boundaries, contain no gap over
1.75 seconds, and retain the same visible process throughout. Sampling overhead can produce
59 well-covered samples in a minute. It does not justify discarding a gap or foreground switch.
An older receipt rejected only by its sample-count gate can be reviewed without rewriting it:

```sh
bun tools/review-frame-foreground.ts /tmp/out-west-ordinary/receipt.json
```

The separate `.foreground-review.json` hashes and links the original receipt, identifies the
review code revision, and preserves every other qualification gate.

```sh
bun tools/record-production-frames.ts --url=http://127.0.0.1:4398 --api=http://127.0.0.1:8798 --population=ordinary --out=/tmp/out-west-ordinary
bun tools/record-production-frames.ts --url=http://127.0.0.1:4398 --api=http://127.0.0.1:8798 --population=stress --out=/tmp/out-west-stress
```

The default is visible Chrome and 60 seconds. `--manual` replaces automated movement/aim/fire
with real operator input. `--headless` and recordings shorter than 60 seconds are always
diagnostics. The ordinary case requires one authenticated human and four bots; stress requires
one human and 31 explicitly synthetic server bots. Both require all corresponding native models
loaded without fallbacks. The unshipped Worker stages a glass break at 10 seconds, environmental
death at 20 seconds and pane reset at 35 seconds. Natural room ticks, normal respawn and actual
movement/firing continue. The receipt labels these staged transitions and compares authority
with client-delivered events and native pane state. This fixture does not establish 32-human
network behavior or natural combat quality.

The builder records Git and content-manifest hashes, hashes the served scripts and inspects
hidden source maps to prove release-engine resolution. `PUBLIC_OW_PERF_HARNESS=1` adds only a
read-only native snapshot; mutable DEV globals must be absent. Local QA uses Cloudflare's test
sitekey and an ephemeral fixture account injected before boot, consumed from session storage.
URL token authentication remains disabled in production. Verify deployment stripping separately:

```sh
bun tools/serve-production-recording.ts --public --build-only --out=/tmp/out-west-public-check
```

Receipts include every frame interval, empty one-second bins, partial final bins, frame
percentiles, trusted input events, audio state, WebGL context and buffer dimensions, DPR, MSAA,
GPU renderer, explicit graphics allocations/deletions, foreground samples and before/after
screenshots. Allocation counters measure explicit calls, not live VRAM or GC reclamation.
Native/context snapshots run once per second; this instrumentation overhead is part of the
measurement. A recording can finish with `qualification: incomplete`; its outstanding evidence
must be resolved before its FPS can serve as acceptance evidence. A qualified desktop trace
still does not meet the iPhone simulator target.

The same local server injects the recorder before game boot for Simulator Safari. Open
`http://127.0.0.1:4398/__qa/start` for ordinary play, or append `?population=stress`. Tap the
game to enable audio, then the recording button; play actively for the full minute. The button
disappears during measurement and the complete receipt is saved in the fixture output directory.
Run the host sidecar for at least 90 seconds in parallel, keep the specific device window visible
and frontmost, and capture its window before and after the run:

```sh
swiftc tools/content/foreground.swift -o /tmp/out-west-foreground
/tmp/out-west-foreground 90 > /tmp/out-west-simulator-foreground.jsonl
```

The saved simulator receipt deliberately remains incomplete until joined with the matching host
trace, simulator UDID/runtime, window screenshots and visual review. This path provides no
physical-device, thermal, A15 or memory-pressure certification. Leave unrelated running
simulators untouched; use a dedicated Out West QA device.

The older DEV-hook regression commands remain useful separately:

```sh
bun tools/test-playcanvas-duel.ts http://localhost:4389
OW_ORIGIN=http://localhost:4389 bun tools/test-playcanvas-frontier.ts
bun tools/playcanvas-perf.ts http://localhost:4389 --rate=4 --seconds=30
```

These commands do not create a production release-engine simulator fixture. The Frontier regression
creates 32 riders, exercises native input/combat and bounded Ammo corpse
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
