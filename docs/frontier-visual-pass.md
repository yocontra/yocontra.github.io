# Frontier visual pass

Status of the AAA/RDR-level pass. All work lands on `master`; the simulation stays authoritative
and deterministic.

## Shipped

- **Real windows.** One shared opening table (`sim/building-rules.ts`) drives the layout, wall cuts,
  collision grid and building audit. 296 openings; hollow walls are cut, solid buildings keep panes
  on the face. Window frames, reveals, sills, lintels, mullions and shutters on the high tier.
- **Breakable glass.** Bullets, rifle rounds and shotgun pellets shatter a pane and carry on. Glass
  never blocks sight. `EV_GLASS_BREAK` (wire v9) plus full-snapshot catch-up; panes are one instanced
  draw, removed by zero scale.
- **Interior doors.** Doorway gaps between collinear partition spans get jambs, heads, thresholds
  and open leaves (double leaves for wide openings), in a wall-mounted `k_door_trim` mesh.
- **Upstairs rooms.** Hotel guest room plus two east rooms; the bank's sealed upstairs room gets a
  door. The building audit now floods every storey with body clearance and fails on sealed rooms or
  walled-off stairs.
- **Lighting.** Sunlit window shafts on the high tier (one merged additive draw), the existing
  baked interior mask and lamp pools, and a slow three-sine lamp flicker.
- **Materials and clutter.** Bottles, glasses and cards on tables and bar counters.
- **Combat feedback.** Soot bullet holes on wall impacts, brass casings from your gun, muzzle smoke,
  the existing dust/blood puffs and hit markers.

## Floor tier

No shadow map. Flat panes on solid buildings; hollow openings stay open. No glass or shafts. The
baked ground mask, contact shade and interior mask are shared with the high tier. Baked shadows and
dynamic resolution remain the fallback.

## Verification

```
bun run api:test                 491 pass, 0 fail
bun run build                    clean
bun tools/building-audit.ts      21 buildings, 0 errors, 0 warnings
bun tools/collider-check.ts      0 invisible walls, 0 walk-through visuals
bun tools/float-audit.ts         0 float, 0 z-fight, 0 untextured (high + floor)
bun tools/frontier-perf.ts       CPU p50 4.6–6.4 ms, p95 6.3–8.2 ms, frame p95 16.8 ms
```

The perf spread is the measurement machine, not the build: the same environment measures the
pre-pass baseline at p50 5.8–6.5, p95 7.8–9.3. The best run of the pass was **4.6 / 6.3**.

Contact sheets: `.playwright-mcp/interiors/contact-sheet.png` (high tier) and
`.playwright-mcp/interiors/floor-exterior.png` (floor tier).

## Blocked: Phase 5 animation and ragdoll

This needs the Mixamo downloads only the account holder can make. Open
<https://www.mixamo.com>, sign in, and download the clips listed in
[`tools/art/mixamo/README.md`](../tools/art/mixamo/README.md) into `tools/art/mixamo/` (FBX Binary,
in place, 30 fps, same character). The manifest is `tools/art/mixamo/manifest.json`.

Once those files are present, the remaining work is:

1. Retarget the clips onto the rig and write `models/moves.glb`.
2. Replace the procedural locomotion layer with the idle/aim/walk/run/sprint/crouch/slide/jump/
   fall/reload/death state graph, with upper-body masks for aiming and firing.
3. Add additive hit reactions and the simple client-side Verlet ragdoll (server capsule stays
   authoritative), pooled and faded after settling.
4. Re-run the gates and capture the animation contact sheet.
