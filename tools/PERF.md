# Out West native performance evidence

Current runs are headless only. They must not open or activate Simulator.app, DeviceHub or a
Mac browser window, take the host cursor, use a real microphone, or contact voice providers.
The simulator target is sustained 30 FPS on the dedicated iPhone 13 mini QA simulator; a
separate desktop target is 58 average FPS with every complete one-second bin at least 55 FPS.
Neither a headless Chrome diagnostic nor a two-second capability preflight completes those
qualifications. Simulator GPU, iOS runtime and host load also differ from a physical A15 phone.

Use the actual local D1/DO fixture and release-engine build, on a committed, clean revision:

```sh
bunx wrangler d1 migrations apply out-west-native-test --local --config api/test/wrangler.native-test.jsonc
bunx wrangler dev --local --config api/test/wrangler.native-test.jsonc --port 8798 --inspector-port 9258 --var 'ALLOWED_ORIGINS:http://127.0.0.1:4398'
bun tools/serve-production-recording.ts --port=4398 --api=http://127.0.0.1:8798
```

The Worker configuration must explicitly report fixture=true and voiceDisabled=true. Both QA
browser bootstraps force voiceChat off before game initialization, reject every getUserMedia
call without invoking native capture, and record the call count. They preserve and restore the
exact prior origin settings, including a retained Safari setting; other gameplay audio runs.
No global privacy settings are changed. QA auth is an ephemeral signed local account consumed
from session storage, and Turnstile uses the documented test key/token with server verification.
No account token or WebSocket ticket is printed in receipts.

The builder hashes served JavaScript and the content manifest, records the source revision and
clean/dirty state, and verifies the release engine using hidden source maps. Explicit
PUBLIC_OW_PERF_HARNESS=1 adds only a read-only native snapshot; mutable DEV globals remain absent.
Check the ordinary build separately; it must strip the snapshot and QA credential entry point:

```sh
bun tools/serve-production-recording.ts --public --build-only --out=/tmp/out-west-public-check
```

Run the two cases sequentially, without competing builds, native probes or CPU producers:

```sh
bun tools/record-production-frames.ts --url=http://127.0.0.1:4398 --api=http://127.0.0.1:8798 --population=ordinary --out=/tmp/out-west-ordinary
bun tools/record-production-frames.ts --url=http://127.0.0.1:4398 --api=http://127.0.0.1:8798 --population=stress --out=/tmp/out-west-stress
```

The default is headless Chrome for 60 seconds; automated trusted browser input moves, aims down
sights and fires. The normal lobby keeps one authenticated human plus four bots. The stress
fixture deliberately raises only its test Worker room to 31 synthetic bots plus one human;
it does not establish 32-human network behavior. Starts are selected with the actual town grid,
player radius and pairwise clearance checks. Normal production and practice bot limits stay four.
Before timing, both cases use the same unshipped native spawn-generation path to prepare
validated capsules around the current104m town's open main street at (52, 52). This is initial fixture
setup, after which movement/combat remain trusted native inputs and ordinary still has four bots.
All 5 or 32 native models must be loaded without fallback before recording starts.

The test Worker stages glass break at 10 seconds, environmental death at 20 seconds and pane
reset at 35 seconds. Natural room ticks, respawn and real movement/firing continue. Receipts
compare authority with delivered lifecycle events/native pane state and require authoritative
ADS input, so scripted interventions cannot be mistaken for natural combat coverage.

Every frame interval is retained, including long stalls, empty one-second bins and the partial
last bin. Receipts include percentiles, trusted input, once-per-second game/audio/WebGL state,
DPR, drawing-buffer size, graphics context loss, native render settings, exact scripts/build
provenance and before/after images. The recorder reads WebGL renderer, version and the currently
bound framebuffer's sample count once before and once after the measured window. These queries
can block on queued GPU work. The per-second samples still record live context and buffer state.
Explicit graphics create/delete counters are not live VRAM or GC measurements. This observer's
cost is part of the measurement. Mac foreground sampling is read-only and remains diagnostic
in headless runs; no Mac foreground claim is manufactured from visible/focused page state.
The optional --visible mode is for a separately authorized foreground session, not current work.

First establish whether Safari can run and receive trusted guest touches without opening any
host simulator UI. The bounded orchestrator refuses existing or unrelated simulator sessions:

```sh
bun tools/record-simulator-frames.ts --preflight --url=http://127.0.0.1:4398 --out=/tmp/out-west-simulator-preflight
```

It reuses the existing Out West QA iPhone 13 mini. If more than one matches, pass
`--udid=<id>` for the device you use for Out West QA. The tool checks that the device is shut
down, boots it via simctl, starts its headless idb_companion on a free port, allows up to 180s
for cold boot, opens the local URL in guest Safari and reads raw guest AX/process
state. Touches use guest HID coordinates derived from native WebArea/button frames and the
browser viewport; unsupported schemas stop without guessed coordinates. It saves two seconds
of rAF, visibility/focus/URL, audio and GL state plus trusted input, native app identity/PID and
guest screenshots. RUNNING alone is not foreground evidence. Missing native identity or any
other capability is an explicit diagnostic, even if browser timing succeeds. It restores this
origin's settings with a guest acknowledgement, stops only its own companion and shuts down
only the device it booted. Raw calls and failures are retained; earlier outputs are not replaced.

This preflight never automatically starts a 60-second simulator qualification. After reviewing
its native evidence, the same local server offers a 60-second Safari recorder at /__qa/start
(or ?population=stress), with real guest gameplay touches required throughout. Its receipt
remains incomplete until independently joined with matching native guest visibility/identity,
UDID/runtime, source/content and input coverage. Mac foreground and physical-device acceptance
are separate, unfinished qualifications.

Historical November 8 simulator traces (ordinary median22.98FPS, packed15.37FPS; later minimal
recorder15.94rAF/s) lacked verified presentation/foreground and preceded later asset changes.
They remain diagnostics. Historical foreground receipts require coverage of both measurement
boundaries with no gap over1.75seconds and the same process; an old sample-count threshold does
not justify discarding gaps. No current performance outcome is inferred from those receipts.

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
