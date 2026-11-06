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
  and open leaves (double leaves for wide openings). On the high tier the leaves swing open as a
  player approaches and creak; the floor tier keeps them merged and static, one draw.
- **Weather.** Periodic dust gusts sweep the street, on top of the airborne motes.
- **Upstairs rooms.** Hotel guest room plus two east rooms; the bank's sealed upstairs room gets a
  door. The building audit now floods every storey with body clearance and fails on sealed rooms or
  walled-off stairs.
- **Lighting.** Sunlit window shafts on the high tier (one merged additive draw), the existing
  baked interior mask and lamp pools, and a slow three-sine lamp flicker.
- **Materials and clutter.** Bottles, glasses and cards on tables and bar counters.
- **Combat feedback.** Soot bullet holes on wall impacts, brass casings from your gun, muzzle smoke,
  the existing dust/blood puffs and hit markers.
- **Death ragdoll.** Three pooled client-side Verlet bodies on the high tier; the crowd actor hides
  while its body falls and is restored on respawn. The authored Death clip is the floor-tier
  fallback and the overflow fallback.

## Floor tier

No shadow map. Flat panes on solid buildings; hollow openings stay open. No glass or shafts. The
baked ground mask, contact shade and interior mask are shared with the high tier. Baked shadows and
dynamic resolution remain the fallback.

## Verification

```
bun run api:test                 495 pass, 0 fail
bun run build                    clean
bun tools/building-audit.ts      21 buildings, 0 errors, 0 warnings
bun tools/collider-check.ts      0 invisible walls, 0 walk-through visuals
bun tools/float-audit.ts         0 float, 0 z-fight, 0 untextured (high + floor)
bun tools/anim-audit.ts          22/22 Frontier animation states pass
bun tools/frontier-perf.ts       CPU p50 4.6–6.7 ms, p95 6.3–8.7 ms, frame p95 16.8 ms
```

The perf spread is the measurement machine, not the build: the same environment measures the
pre-pass baseline at p50 5.8–6.5, p95 7.8–9.3. The best run of the pass was **4.6 / 6.3**.

Contact sheets: `.playwright-mcp/interiors/contact-sheet.png` (high tier) and
`.playwright-mcp/interiors/floor-exterior.png` (floor tier).

## Animation state graph and ragdoll

The full locomotion graph is in `scene/locomotion.ts` and uses the CC0 Quaternius Universal
Animation Library clips already baked into `player.glb` and `moves.glb`:

- **Base states:** idle, holstered/aiming, walk, run, sprint, crouch idle/walk, jump/fall, death.
- **Upper-body layers:** the gun arm (`Idle_Gun_Pointing`), pistol shot (`Idle_Gun_Shoot`), reload
  (`Reload`), and two hit reactions (`HitRecieve`, `HitRecieve_2`), all masked by `UPPER`/`ARM_R`.
- **Procedural layers:** leg yaw and stride for strafing/backpedalling, turn-in-place, slide, roll,
  vault, landing dip, long-gun IK and the support hand.
- **Audited:** `bun tools/anim-audit.ts --skip=duel,live` passes **22/22** Frontier states, including
  third- and first-person reload, hip/ADS fire, strafe, backpedal, sprint, crouch, slide, jump and
  the remote riders.

UAL has no rifle- or strafe-specific clips, so the rifle uses the pistol aim/shoot/reload layers
with the long-gun IK, and strafing uses the walk/run cycles with procedural leg yaw. Mixamo is ruled
out: its terms do not allow shipping the clips in an OSS repository.

The authored `Death` clip remains the floor-tier fallback. The simple client-side Verlet ragdoll is
shipped on the high tier: three pooled bodies, spawned on `EV_KILL`, hidden crowd actor, released on
respawn.
