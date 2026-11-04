# out west performance: tiers, measurements, device checklist

The floor device is the **iPhone 13 mini (A15, 4 GB) in an iOS 27 WKWebView** (design doc §9). Every
number below comes from **emulation on a desktop**, not the real device. Real-device validation is
still required before any of it counts. See the checklist at the end.

## What's in the engine

- **Tiers** (`engine/tiers.ts`): high / medium / floor / legacy, per §9.4. Quick Draw floor runs at
  DPR 1.6 (dynamic 0.8–1.0), 4× MSAA, a 1024² shadow and half-res 4-mip bloom. Frontier mode
  (`new Renderer(..., 'ffa')`) uses DPR 1.3 (0.7–1.0). Legacy drops MSAA for FXAA, plus vignette
  and grain.
- **Detection:** a form-factor prior (touch + small screen means floor; touch means medium; desktop
  means high; a software GL means legacy), then a 1.5 s GPU micro-benchmark. The benchmark renders
  a lit, shadowed 40k-tri standard-material scene into a 1024×512 4× MSAA target, sliced across
  rAFs and timed with `gl.finish()`. The result is cached in `localStorage` per user agent and
  benchmark version (`ow-quality:v1`). Force a tier with `#tier=high|medium|floor|legacy`; main.ts's
  `#tier=low` maps to floor.
- **Dynamic resolution** (`Renderer.adapt`), every 0.5 s:
  - If the p90 rAF interval misses the display refresh (estimated as p10) by more than 15 %, the
    scale steps down 0.05.
  - If frames are on time and CPU p90 is under 60 % of refresh, it steps up 0.05, after a 4 s hold.
  - Pinned at the floor for 3 minutes is treated as thermal: drop one tier, never climbing back.
  - Never during tense duel phases (game.ts only calls `adapt` outside them).
  - Low Power Mode (steady ~33 ms frames with idle CPU) is detected and shown, and doesn't drop
    resolution.
- **Post:** one merged EffectPass: bloom composite, AgX, grade + per-time-of-day 32³ LUT pair,
  vignette and grain. Bloom's own mip chain runs at half res. The lens pass (CA, shimmer, blur)
  only runs while a moment asks for it.
- **Overlay:** add `?debug=perf` or `#perf`. It shows fps, frame p50/p95, CPU ms (rAF start to end
  of submit), GPU ms (timer query where available; never on iOS), draws, tris, textures (count and
  estimated MB), geometries, programs, JS heap, tier, DPR and scale, benchmark ms, thermal drops and
  low power. `globalThis.__owPerf()` returns a snapshot for scripts.

## How these were measured

Playwright (Chromium 156, ANGLE Metal on an **Apple M2 Max**), in a new page:
- `Emulation.setDeviceMetricsOverride` at 812×375 CSS, DPR 3, mobile, touch on;
- `Emulation.setCPUThrottlingRate` at 1×, 4× and 6×;
- a duel at `#level=6&debug` (the walk phase, two heroes, the full street).

GPU time comes from an init script that wraps every rAF batch in an
`EXT_disjoint_timer_query_webgl2` query. CPU time is the same batch's wall time.

How to read the throttle rates:
- **4×** is a conservative A15-in-WKWebView proxy. The A15 single-core is roughly 1.5–2× slower
  than an M2 Max; the extra margin is for WKWebView's JIT and thermals.
- **6×** is a worst case.
- GPU numbers are M2 Max numbers. An A15 4-core GPU has about 1/8–1/10 of the M2 Max's ALU and
  bandwidth, but fixed timer-query overhead inflates small desktop numbers. Treat them as relative
  (before vs after), not absolute.

### Quick Draw duel (walk phase), before vs after

|                      | Before (old "low" tier) | After, floor tier                            | After, legacy tier       |
| -------------------- | ----------------------- | -------------------------------------------- | ------------------------ |
| Internal res         | DPR 1.25, no AA         | DPR 1.6 (dyn 1.52), 4× MSAA                  | DPR 1.0 (dyn 0.95), FXAA |
| Post                 | ACES, 8-mip bloom       | AgX + LUT, 4-mip half-res bloom, merged pass | AgX + LUT                |
| IBL                  | none (hemisphere)       | runtime town probe (PMREM)                   | same                     |
| Draws / tris         | 78 / 128k               | 70 / 127k                                    | 69 / 127k                |
| CPU p50/p95, 1×      | 0.8 / 0.9 ms            | 0.6 / 0.8 ms                                 | 0.5 / 0.8 ms             |
| CPU p50/p95, 4×      | 2.0 / 3.0 ms            | 2.9 / 3.8 ms                                 | 3.2 / 4.3 ms             |
| CPU p50/p95, 6×      | 4.3 / 5.8 ms            | 5.5 / 7.1 ms                                 | 4.8 / 6.7 ms             |
| GPU p50/p95 (M2 Max) | 2.04 / 2.45 ms          | 1.09–1.25 / 1.55–1.86 ms                     | 0.77–1.4 / 1.1–2.5 ms    |
| JS heap              | ~54–64 MB               | ~62 MB                                       | ~67 MB                   |

The in-renderer GPU timer (`#perf`, which brackets only the composer) put the floor frame at
~3.0 ms on the M2 Max. The breakdown below was measured by disabling one stage at a time:
- turning off the IBL saves ~0.15 ms;
- turning off MSAA saves ~0.6 ms;
- turning off post saves ~1.3 ms;
- turning off shadows saves ~0.13 ms.

**Post and pixel count dominate. They're the first levers on the real device** (dynamic resolution
already pulls the pixel count).

Downloads added: ARM maps (390 KB) and the signboard normal/ARM (165 KB). LUTs are generated at
runtime (128 KB of GPU each, 2 resident). The probe is ~0.6 MB of GPU (128² half-float cube plus
PMREM).

### AAA asset pass (textured characters, kit props and buildings), Nov 2026

Same harness (`#perf&tier=floor`, 812×375 CSS at DPR 3, CPU 4×), Quick Draw level 7 walk/wait and
the Frontier (`?bots=31`), before (`87d93c9`) vs after:

|                       | Duel before | Duel after  | Frontier before | Frontier after    |
| --------------------- | ----------- | ----------- | --------------- | ----------------- |
| Draws (max)           | 70          | 71          | 70–72           | 58–73             |
| Triangles (max)       | 128k        | 242k        | 259k            | 234–262k          |
| Texture MB (estimate) | 60.5        | 137         | 54.4            | 131               |
| Frame p50 / p95 (ms)  | 16.7 / 16.8 | 16.7 / 16.7 | 16.7 / 16.8–33  | 16.7 / 16.8       |
| CPU p50 / p95 (ms)    | 3.9 / 5.2   | 4.1 / 5.0   | 6.7–7.2 / 9–23  | 5.0–7.2 / 6.5–9.1 |

Budgets (§9.3): duel ≤120 draws, ≤400k tris, ≤160 MB textures; Frontier ≤180 draws, ≤350k tris,
≤200 MB. Characters are 14–20k tris at LOD0 with 52–53 bones. The texture growth is the shared
character atlas (2048×3072 albedo + two 1024×1536 maps ≈ 50 MB with mips) and the kit atlas
(1024×3648 + two half-size maps ≈ 30 MB); KTX2 would cut both ~4× (see tools/README.md).

### Frontier crowd (measured on the M1 crowd test page, since folded into Frontier; FFA floor tier, DPR 1.3)

Final architecture:
- the nearest 16 are skinned (own player at LOD0, the rest at LOD1, ~4k tris);
- the nearest 6 cast real shadows; everyone else gets a blob;
- everyone else is a VAT instance of their base body (LOD2, 1.5k tris, ~900 verts, 252 KB each,
  1.78 MB for all 7 bases);
- each far player has a per-instance palette tint, and hats are instanced per hat type.

| Config                              | CPU p50/p95 1× | 4×               | 6×          | Draws | Tris     |
| ----------------------------------- | -------------- | ---------------- | ----------- | ----- | -------- |
| A: 16 skinned + 16 VAT, spread      | 1.5 / 1.9      | 6.9 / 8.9        | 16.4 / 22.2 | ~100  | 211–244k |
| B: 16 skinned + 16 VAT, all in view | 1.6 / 2.1      | 6.7–8.6 / 9.4–15 | 15.0 / 21.8 | ~110  | 210–245k |
| 12 skinned + 20 VAT, all in view    | 1.5 / 1.8      | 6.0 / 7.9        | 13.6 / 19.7 | ~100  | 226k     |
| 32 VAT, all in view                 | 1.0 / 1.5      | 4.0 / 8.1        | 10.2 / 31.6 | ~67   | 142k     |
| (first spike) 32 skinned LOD0       | 2.1 / 2.5      | 12.6 / 18.3      | 20.2 / 26.3 | ~170  | 460k     |

Notes:
- Mixer p95 at 4× is 0.8–1.3 ms; most of the skinned cost is three.js submission plus bone-texture
  uploads.
- M2 Max GPU: 1.2–1.9 ms.
- VAT bake: 0.4–0.9 s per base the first time (worker), ~16 ms from IndexedDB.
- The lead set near=12–16 skinned on floor/medium and 8 on legacy (stream G).

### Frontier CPU and heap pass (final audit), Nov 2026

Harness: `bun tools/frontier-perf.ts [--cluster] [--portrait]` (loopback, 31 bots, 812×375 CSS at
DPR 3, touch, floor tier, 4× CPU, sampled every 2 s for 30 s after a warm-up, dev server).
`--cluster` is the packed scene: dev `?cluster` makes the bots circle the player and fire outward,
so 15–21 riders are on screen (counted by projecting them through the live camera).

|                          | Before (audit) | After, spread | After, packed (`--cluster`) |
| ------------------------ | -------------- | ------------- | --------------------------- |
| CPU p50 (ms)             | 7.0            | 4.1–6.0       | 4.8–5.1                     |
| CPU p95 (ms)             | 7.8–8.8        | 5.6–7.5       | 6.5–6.7                     |
| JS heap, median (MB)     | 93–129         | 94–104        | 91–100                      |
| Garbage (MB per 10 s)    | 173–210        | 89            |                             |
| Crowd triangles (packed) | ~178k          |               | ~97k                        |
| Triangles (max)          | 259k / 450k+   | 303–341k      | 342–363k                    |

Machine load from parallel agents moves p95 by about ±0.8 ms between runs. The heap max still
peaks at 110–150 MB right after a burst of actor casts, until the next GC. Dev builds also carry
about 20 MB of module source strings that production doesn't.

What changed:
- **Crowd churn.** The crowd evicted actors in arbitrary order and re-baked the same riders every
  few frames (54 casts in 30 s, packed). Each cast is a full dress-and-bake plus a GPU upload.
  Now:
  - eviction goes by distance rank and never touches the prebuild ring;
  - up to near + 20 built actors are parked off the graph for 90 s.
- **Program re-resolves.** `getProgram`/`getParameters` ran several times a frame. The fixes:
  - a kit-material twin for loose meshes;
  - `forceSinglePass` on the additive fx;
  - one shadow depth material per caster kind (`ffa/scene/depth-kinds.ts`).
- **Boxed doubles.** `Matrix4.toArray` gets a monomorphic Float32Array fast path
  (`ffa/scene/hot-paths.ts`). Before it, `Skeleton.update` made 7.7 KB of garbage per skeleton per
  frame.
- **Bone compose.** Rig bones compose only when their mixer ticks (30 or 15 Hz).
- **Body bakes.** `blendBones` reads skin attributes directly.
- **Hats.** Other riders' hats now use an LOD: 800 triangles near, 300 in the VAT crowd, down from
  3.5k each.

### Frontier shooter views (over the shoulder, first person), Nov 2026

Harness: `bun tools/frontier-perf.ts --view=top|third|first [--cluster]`. It uses the same floor
proxy as above: loopback, 31 bots, 812×375 CSS at DPR 3, touch, floor tier, 4× CPU, and 15 samples.
In the shooter views the camera pans 30° per sample, so every run looks all the way round the
horizon. These numbers are on the rebuilt Perdition (`redesign` after the map rebuild and the
stutter fix), with other agents loading the machine. Read the views against each other within one
run; don't compare them with the older tables.

|                 | Top-down, spread | Third, spread | First, spread | Top-down, packed | Third, packed | First, packed |
| --------------- | ---------------- | ------------- | ------------- | ---------------- | ------------- | ------------- |
| CPU p50 (ms)    | 7.5              | 6.8           | 5.9           | 7.5              | 8.6           | 9.1           |
| CPU p95 (ms)    | 9.6              | 8.8           | 7.3           | 9.4              | 10.2          | 11.0          |
| Draws (max)     | 65               | 99            | 89            | 132              | 128           | 124           |
| Triangles (max) | 387k             | 417k          | 379k          | 451k             | 447k          | 413k          |
| Textures        | ≤81              | ≤80           | ≤72           | ≤81              | ≤80           | ≤79           |

The shooter views cost about the same as top-down: within ±1 ms p95 in the same run. Two runs of
the same view differ by up to 1.5 ms under the current machine load. What keeps the horizon cheap:
- **Draw distance and fog by tier** (`ffa/client/view.ts`):
  - floor: 120 m far plane, fog 38 to 118 m;
  - legacy: 90 m, fog 28 to 88 m;
  - medium: 190 m;
  - high: 230 m.
    The far end melts into the haze colour instead of popping.
- **Shadows follow the view.** The sun's box centres ahead of you (7 m on floor) and stays small:
  a 12 m half-size on floor and legacy's 10 m, against 24 m on high.
- **The crowd is ranked from your position**, not the old look-ahead point. The nearest 12 or 16
  riders stay skinned and the rest are VAT instances, which read correctly from street level, hats
  included. Characters render at life size in the shooter views (`Crowd.readScale` 1; top-down
  keeps 1.25).
- **First person** hides your own body and draws a 3–6 draw view model instead.
- **The bank guide's path walk** runs at 10 Hz. Its walking-distance field is flooded once at
  load, about 5 ms.

The rebuilt town alone puts top-down over the old budget: CPU p95 over 7 ms and triangles over
350k. That needs a pass on the town's geometry, not on the camera.

### Perdition geometry pass (town LOD), Nov 2026

Harness: `bun tools/frontier-perf.ts --view=third [--cluster]` (floor proxy as above). Before and
after were run back to back on the same dev server and the same machine load (load average about
5, other agents running). Before is `redesign` d26e0ac.

|                 | Before, spread | After, spread | Before, packed | After, packed |
| --------------- | -------------- | ------------- | -------------- | ------------- |
| CPU p95 (ms)    | 8.4            | 8.0           | 10.7           | 8.2           |
| CPU p50 (ms)    | 6.0            | 6.1           | 7.9            | 5.9           |
| Draws (max)     | 111            | 115           | 152            | 137           |
| Triangles (max) | 490k           | 271k          | 539k           | 306k          |
| JS heap (MB)    | 104            | 134           | 117            | 141           |

Of the ~270k that remain, the town is about 120–170k in a view; desert flora is up to ~42k and the
riders, pickups and effects are the rest. The heap grows by about 30 MB: merged per-tile kit and
the far batch replace instancing, which shared one geometry per prop.

What `ffa/scene/town.ts` does now:
- **Detail tiles.** Every kit piece (windows, frames, doors, fences, barrels, crates, hay, lanterns,
  outskirts rocks and the boundary fence) merges into a 36 m tile. A tile draws only when the
  camera is within 46 m of it (30 m on floor and legacy).
- **One far batch per material.** Beyond that radius, stand-ins draw instead:
  - fences, closed doors and rocks are vertex-clustered (`ffa/scene/lod.ts`; a 432-triangle rock
    comes out at a few dozen);
  - windows become two flat quads.
    Every vertex carries its tile id. A uniform array in the vertex shader folds away the tiles that
    show full detail, so the whole far layer costs one draw per material.
- **Small props never vanish.** Barrels, crates, crate stacks and hay get an inset box or cylinder
  stand-in in the always-drawn wood batch. From afar that is the prop; up close the kit prop
  covers it.
- **Rooms.** Each walk-in building's furniture, ceiling and inside windows are their own group.
  They draw only within 18 m of the building (12 m on floor and legacy), or with the camera inside.
- **Balcony rails** are built geometry (about 200 triangles per 2 m against the kit balcony's
  1,120). The outskirts terrain is split into four sides of town, so the side behind the camera is
  culled.
- **Floor and legacy** also drop facade trim and ceiling joists.
- **Visibility** updates from the ground mesh's `onBeforeRender`, for perspective cameras only (so
  not the sun's shadow camera); `Town.update(camera)` is also public. When the dev audits'
  `owAuditScenes` hook is present, everything shows at full detail.

#### Heap follow-up

The +30 MB above was mostly a leak, not merging. `buildTown`'s update and dispose closures were
created in its scope, so they kept every builder's plain-number vertex arrays alive (the
structure batch alone is about 1M numbers). Fixed:
- the culler and the disposer are now built by module-level factories, so their closures capture
  only what they use;
- every town-owned vertex and index array drops its CPU copy on GPU upload
  (`BufferAttribute.onUpload`), with bounding spheres computed first. The exceptions are instanced
  meshes (their geometry is shared) and runs where the dev audits are watching. Groups that have
  never been drawn, such as rooms you haven't been near, keep their arrays until they first draw.
- coarser far stand-ins: rocks are clustered at 30% of their size, fences at 10% and doors at 12%.
- floor and legacy draw detail tiles within 27 m (was 30) and rooms within 10 m (was 12).

| Floor proxy, post-GC JS heap                | `d26e0ac` | Now                          |
| ------------------------------------------- | --------- | ---------------------------- |
| bots=0, after load                          | 98.3 MB   | 93.2 MB                      |
| Town vertex/index arrays held in JS         | 13.5 MB   | 4–7 MB (falls as rooms draw) |
| 31 bots packed (crowd arrays vary 11–17 MB) | 118.6 MB  | 124.7–127.9 MB               |

Instancing the repeated props was tried as one instanced batch per prop across tiles, refilled
when the near tiles or the view changed. It cost 2–3 ms of CPU p95 at 4× (the per-frame refill and
upload), and freeing the merged copies saves the JS heap anyway. Merged per-tile kit stays.

Packed third person, three runs on the floor proxy (the spawn is random, so the view differs run
to run): triangles 288k, 304k and 288k against 539k before; CPU p95 8.9–10.0 ms at load average
5–7.

### Frontier baseline, seeded harness (Nov 2026)

`tools/frontier-perf.ts` now starts every run from the same scene. It uses the loopback lobby's
seed 7 (which fixes the bots, their spawns and the strongbox) and puts you on the bank's front steps
(72, 69), via the dev-only page params `?seed=7&spawn=72,69`. Other start points: `--spawn=` a name
(`crossroads`, `saloon-porch`, `west-end`, `east-end`, `depot`, `corral`) or `x,z`.
`--seed=random --spawn=random` gives the old behaviour.

Repeatability: two back-to-back packed third-person runs gave 298k and 298k triangles, 139 and 139
draws, 122.3 and 122.2 MB heap, and 9.6 and 9.5 ms CPU p95. Triangle, draw and heap figures are
now exact comparisons. CPU still moves with machine load, so read it within one sitting.

Floor proxy (812×375 at DPR 3, touch, floor tier, 4× CPU, 31 bots, 15 samples, the camera
panning a full circle), on `redesign` 1518366 with the town LOD and heap passes, at load average
4–6:

|                 | Third, spread | Third, packed | First, spread | First, packed | Top, spread | Top, packed |
| --------------- | ------------- | ------------- | ------------- | ------------- | ----------- | ----------- |
| CPU p50 (ms)    | 6.1           | 6.8           | 5.3           | 8.3           | 7.0         | 7.2         |
| CPU p95 (ms)    | 8.3           | 9.1           | 7.4           | 10.5          | 8.5         | 9.2         |
| Frame p95 (ms)  | 16.7          | 16.8          | 16.7          | 16.8          | 16.8        | 16.8        |
| Heap, median    | 122.7 MB      | 122.5 MB      | 122.2 MB      | 123.6 MB      | 128.3 MB    | 121.8 MB    |
| Draws (max)     | 107           | 139           | 105           | 128           | 81          | 150         |
| Triangles (max) | 229k          | 298k          | 227k          | 274k          | 209k        | 294k        |
| Riders in view  | 2 (max 7)     | 11 (max 16)   | 2 (max 7)     | 9 (max 15)    | 2 (max 2)   | 19 (max 22) |

Against the budget (≤300k triangles, CPU p95 ≤ 7 ms on a quiet machine, heap ≤ 110 MB):
- triangles are inside in every view;
- CPU and heap are over. What's left is the crowd (skinned and VAT riders, 11–17 MB of their own
  arrays), the desert flora, and the dev build's module source, which production doesn't carry.

## Real-device checklist (iPhone 13 mini, current iOS, WKWebView)

Do this before signing off any art drop. The pass bar (§9.6): **p95 ≤ 16.7 ms over 10 minutes,
no tier drop before 10 minutes, WebContent process < 700 MB, no WebGL context loss.**

1. **Harness:** the throwaway Expo dev client with `react-native-webview` and `isInspectable`,
   pointed at the dev URL. Also test plain Safari, because the limits differ.
2. **Tier detection:**
   - [ ] Open `#perf` fresh (clear site data). Note `bench` ms and the detected tier. Expected:
     floor.
   - [ ] If the bench lands far from ~9 ms, recalibrate `A15_MS` in `engine/tiers.ts` and bump
     `BENCH_VERSION`.
3. **Duel, 10 minutes**, on `#perf` with the standoff camera (play the gauntlet) at noon, sunset
   and night:
   - [ ] Frame p95 ≤ 16.7 ms and a steady 60 fps.
   - [ ] Scale settles ≥ 0.9.
   - [ ] No thermal drop.
4. **Frontier crowd**, at `/experiments/out-west/frontier/?bots=31#perf` against a local API
   (server bots are dev-only), standing where the bots fight:
   - [ ] p95 ≤ 16.7 ms for 10 minutes.
   - [ ] Note the first VAT bake time and the warm IndexedDB load.
5. **Safari Web Inspector** (Develop → device):
   - [ ] Timelines: JavaScript, Rendering Frames and Memory, during a duel draw and a kill cam.
   - [ ] Canvas tab: record one frame. Count draws and passes; expect a single post pass plus the
     bloom mips.
6. **Xcode Instruments:**
   - [ ] Metal System Trace: GPU frame time, and check that MSAA resolves on-tile (no big resolve
     blit).
   - [ ] Allocations / VM Tracker on WebContent: < 700 MB.
7. **Edge cases:**
   - [ ] Low Power Mode: the overlay shows "LOW POWER 30 Hz" and the resolution doesn't collapse.
   - [ ] Background the app for 5 minutes, then return: no context loss and the probe still lit.
   - [ ] Rotate portrait ↔ landscape mid-duel: no hitch beyond one frame.
8. **Thermal:**
   - [ ] Play 15 minutes back to back in a warm room. Record when (if) a tier drop happens.
9. **Record** each run's numbers in this file, with device, iOS version, build hash and date.

### Reproducing the desktop emulation

In a Playwright page (`page.context().newPage()`):

```js
const cdp = await p.context().newCDPSession(p)
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 812,
  height: 375,
  deviceScaleFactor: 3,
  mobile: true,
})
await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
await p.goto('http://localhost:4347/experiments/out-west/#level=6&perf&tier=floor')
// tap to start, wait, then:
await p.evaluate(() => globalThis.__owPerf())
```

## Clock tower (courthouse) budget

The tower draws 3 meshes of its own (masonry atlas, iron + bronze with in-shader hands and bell,
enamel dials); its timber, glass and kit pieces join the street batches. The old church drew 4.
Textures: `civic_*` atlas, 1024² diffuse plus 512² normal and ARM (about 8.4 MB of GPU), and a
512² dial canvas (1.4 MB). The duel scene estimate went from 137.0 MB to 146.0 MB. Geometry is
about 20k triangles before the shadow pass. Frontier's tower uses no new textures.
