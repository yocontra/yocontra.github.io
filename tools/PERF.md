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
