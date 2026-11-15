# Out West completion ledger

Execution baseline: remote master `62b0e5e`, fast-forwarded 2026-11-14.
Integration branch: `finish/out-west-integration-20261114`.
Recovery archive: `/Users/contra/Projects/out-west-recovery/20261114` (complete Git directory and prior local plans). Do not prune until recovery review is complete.

## Accepted direction

Photoreal overhaul of existing browser/mobile modes. Free/CC0 assets and original Blender authoring; headless Blender preferred. Horse clips, not new riding gameplay. Gated releases. Latest user constraint: headless-only automation; do not open visible browsers, capture the host cursor, activate applications or force foreground. Foreground qualification remains pending under this constraint. Preserve balance, independent spectators and all 94 historical GLBs. No asset or feature is accepted solely because its tests pass.

## Work and evidence

| Package                      | Owner        | Status / remaining gate                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recover all worktrees        | Integrator   | Archived 31 missing worktree metadata sets, reflogs and original plans; master current. Seven distinct candidate heads remain subject to selective review.                                                                                                                                   |
| First-person pipeline        | Integrator   | Recovered `fc6d49b` as `0c1b93a`; regenerated current derivatives in `8b5f64c`. 3 extraction tests pass, 5472 assertions. Elbow poses integrated in `6341efc5`; portrait/landscape sight obstruction fixed. Lifecycle `7732e72f`/`298d1043` passes; hip framing and final art review remain. |
| Receive-only voice           | Voice worker | Integrated `1cb04d35`; 37 pinned voice/server tests pass. Browser fixtures cover denied/missing/ended mic and same-meeting recovery; new live SFU validation still outstanding.                                                                                                              |
| Texture quality profiles     | Art worker   | Integrated `5aaad0f`; explicit preservation/high/low profiles, four tests pass. Hero authoring quality still open.                                                                                                                                                                           |
| Duel parity                  | Duel worker  | Integrated `a2cb5046`, offline TipHat `3d5ff13b`; 240 integrated tests pass. Native Underboss/Boss probe passed in worker; TipHat native review and repaired seated-anchor probe pass; original Underboss/Boss side-by-side remains.                                                         |
| Characters/material coverage | Art worker   | All outfits, paired fits, 17 outlaws, crowds and actual lighting coverage required.                                                                                                                                                                                                          |
| Animals                      | Integrator   | Recovered horse candidates in `906df7ff`/`9fc1b6a1`; retained prior texture bytes. Native review open; crow fold still open.                                                                                                                                                                 |
| Environment                  | Integrator   | Siding, adobe, crates, terrain, flora, structure and interiors; preserve collision or version coordinated changes.                                                                                                                                                                           |
| Lighting/effects             | Queued       | Calibrated materials, native tiers and full scene/day-night review. QA camera candidate `958f6b9` is not a lighting upgrade.                                                                                                                                                                 |
| Audio                        | Audio worker | Recovered candidates; `5e1fe2a6` adds post-limiter headroom. Ordinary/cluster peaks -2.6/-2.5 dBFS. Dense-firefight automated listening median 3/10: unaccepted. Reverted a mix experiment with no improvement.                                                                              |
| Performance                  | QA worker    | Visible release-engine simulator/Chrome recorder; 60-second active runs, both orientations, ordinary and 32-player stress; retain every slow frame.                                                                                                                                          |
| Delivery                     | Queued       | Full check/build/native probes, immutable old assets, current hashes/previews, exact Worker then Pages revision verification.                                                                                                                                                                |

## Swarm rules

One integrator plus three workers, exclusive file ownership and isolated durable worktrees. Single Blender authoring lane. Integrator owns generated shared manifests and release. No production promotion until native visual/audio acceptance and appropriate tests pass. Do not mark TODO checkboxes complete from this ledger alone.

## Outstanding qualification

Eleven TODO items remain unchecked after verified arm pipeline, masks, Dead-Eye and receive-only voice updates. The live SFU caveat remains explicit. Complete arm runtime lifecycle, masks, shadows, framing, action timing and Dead-Eye; material/animal/environment/parity work; receive-only voice; all four performance requirements; final source/content review and verified release. Reassess checked art/audio work against the photoreal direction.

Current diagnostics live under `/tmp/out-west-*`; archive accepted evidence durably before release. The first-person probe was initially invalidated by concurrent asset regeneration/HMR and is being rerun on stable files. Simulator results do not establish physical-phone performance.

Pinned Bun 1.3.14 broad candidate suite: 369 pass, zero failures. Host Bun 1.4.4 produced default-timeout failures and is not the qualification runtime. First-person portrait and landscape probes passed the initial candidate but visual framing failed. Follow-up lifecycle fix `7732e72f` needs the worker's disabled-socket readiness correction and native rerun before acceptance. Asset author is creating FP-only hand-contact-preserving pose variants with headless Blender. Duel worker is repairing the stale seated-anchor probe (actual seated pose/seatY contract) before performance recorder work. `c1830ca` adds tested timing summaries retaining empty seconds and stalls; it does not complete visible simulator/Chrome qualification.

## Integration updates

- Native LOD import regression `6b29d0c7` fixes PlayCanvas unique-name suffixes corrupting hysteresis. `39c09372` publishes `frontier-detail.glb` while retaining the old Frontier container exactly. Real native 32-player/gameplay probe passes with zero browser errors; compatibility/import tests pass. This is functional evidence, not final performance qualification.
- `f89614ef` preserves the public lobby ID from admission rather than leaking Colyseus internal room identity. Real Worker fixture verification is assigned to QA.
- Calibrated scanned siding is integrated in `1bb78bb7` after native day/dusk/night review; the first washed-out candidate was rejected. Frontier is now about 46 MiB and still needs final performance qualification. Earth-plaster mission surfaces remain staged; close-up review and physical-scale calibration are in progress. No collision changes.
- Hero authoring checkpoint `986c6ba3` retains CC0 anatomical sources, editable Blender scene and native preview tooling. Production character assets remain unchanged. Native close-ups caught collar, hat, eye and weapon-grip defects; full clothing/material/animation acceptance remains open. Headless Blender is the preferred authoring path.
- Audio source candidates are being blindly compared. First black-powder report candidate was rejected; no poor candidate was promoted.
- Full suite passed on pinned Bun before the latest LOD changes; final combined check/build still required. Source/tools typechecks pass after lobby identity repair.

## Current qualification receipts

- First-person native portrait/landscape feedback passes all three weapons, standing/crouched hip/sights, physical eye alignment and Dead-Eye charging/ready/release. Outfit swap allocation counts remain stable. Final hip framing and complete action/cancellation coverage remain open.
- Footstep slot selection now filters stationary/sliding riders before limiting moving enemies (`6584272e`, CI regression `883ff2cc`). New dense-firefight audio remains unaccepted; ordinary and clustered comparisons must use matching review prompts and event loads.
- Full pinned-Bun suite passed in 153.6 seconds; remaining formatting failures were corrected and Biome passed. Final combined check is still required after current changes.
- The first 60-second Chrome diagnostic measured 99.40 mean FPS and 83 minimum full-second FPS, but its foreground observer could miss app switches. Continuous-foreground qualification was withdrawn. `f85e710e` fixes the observer; a new run is required. Desktop qualification now requires mean >=58 FPS and every full second >=55, separately from simulator >=30.
- Dedicated iPhone 13 mini simulator reaches the authenticated game through an unshipped local Turnstile test fixture. No accepted simulator frame receipt yet; host foreground verification remains unresolved. Simulator evidence will not establish physical-device performance.
- All 94 historical non-native GLBs remain byte-identical to `62b0e5e`. Evidence copies are retained under `/Users/contra/Projects/out-west-evidence/20261114`.

## Remaining recovered-branch dispositions

- `swarm/character` contains optional source material ideas and 588 stale generated files; do not merge its generated output. New hero authoring uses the current canonical rig.
- `swarm/combat-feel-2` changes touch aim assistance; rejected under the approved balance-preservation boundary.
- `304ac400` combines tracer changes with aim assistance; no blanket merge. Any visual-only extraction needs an independent native review.
- `bb08e308` adds bullet decals, surface lookup and a wire-protocol revision. Deferred from current integration until contract, rendering and performance review; coordinated Worker-first delivery is required if accepted.
- Missing worktree metadata and reflog-only commits remain archived. Nothing has been pruned.

## Latest integrated work

- `e7cde11e` replaces mission dirt-textured adobe with calibrated 2 m earth plaster, retaining all non-UV geometry. Native wall/cloister captures cover three acts; the container grows 18.0 to 28.8 MB. Final performance gate remains open.
- `ad673dc6` verifies Underboss two-shot timing and Boss second phase against original engine `18e39f5`. Paused transient effects are settled using the mounted Vite module instance. Comparison images/receipts are durably archived; the parity TODO is closed.
- `3c72b205`/`4d2e7b38` integrate coherent recorded CC0 reports/boots/timber and bounded native HRTF for enemy footsteps. Normal listening matches the baseline, while dense enemy-footstep readability remains unaccepted. Combined audio/foreground focused checks: 15 pass, 283 assertions. `8f4ee4e7` preserves the lint-debt budget.
- `f952504a`/`98a36959` reuse exact authored keyframes with layer-specific track curves. The corrected test explicitly starts native playback and requires non-rest poses; all 73 clips/masks/transitions agree. Full headless 32-rider lifecycle passes. Headless stability: 59.64 FPS at 60 Hz, p99 16.8 ms, max 33.4 ms, zero errors. No geometry/material/rate reductions.
- `57d1e5fb`/`9d0c7c16` record the headless-only user constraint, make performance tools headless by default and remove automatic app activation. Automation-owned visible browsers were closed; user browser windows were untouched. No further visible or simulator activation runs are authorized in this session.
- `7f8e0a11`/`06040f0c` preserve isolated hero source authoring and route unaccepted preview content from `/tmp`. Clothing/head fit and weapon grips remain below acceptance; no production hero replacement.
- `0799ff83` honors explicit external-PBR normal strength while preserving the 1.4 historical fallback. Native candidate receipts verify the authored 0.4 value. Crow articulated fold/feather corrections remain staged pending final geometry/transition review.
- `2b359391` owns asynchronous first-person actor loads through cancellation and disposal. Real native lifecycle regression coverage passes; expanded actual-GLB action timing and final framing remain under review.
- `2a69368b` fixes a reproduced native animation crash: restarting a one-shot discarded clips still referenced by an interrupted blend. The failing native-controller regression now passes; all 36 actual crow static/transition captures pass with zero browser errors. Evidence is archived under `out-west-evidence/20261114/crow-restart-fixed`. The crow remains a staged source candidate: feather seams, body plumage and flight silhouette still need art refinement.
- Combined check follow-up: 1017/1018 tests passed, with an autonomous Worker tick timeout; its isolated rerun passed. Test type errors and harness/vendor-data formatting are fixed, full Biome is clean, and source/tool test typechecks pass. Shop previews still require regeneration and the final combined check remains outstanding. No release has been made.
