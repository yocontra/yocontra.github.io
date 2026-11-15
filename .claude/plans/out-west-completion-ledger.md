# Out West completion ledger

Execution baseline: remote master `62b0e5e`, fast-forwarded 2026-11-14.
Integration branch: `finish/out-west-integration-20261114`.
Recovery archive: `/Users/contra/Projects/out-west-recovery/20261114` (complete Git directory and prior local plans). Do not prune until recovery review is complete.

## Accepted direction

Photoreal overhaul of existing browser/mobile modes. Free/CC0 assets and original Blender authoring; headless Blender preferred. Horse clips, not new riding gameplay. Gated releases. Preserve balance, independent spectators and all 94 historical GLBs. No asset or feature is accepted solely because its tests pass.

## Work and evidence

| Package | Owner | Status / remaining gate |
| --- | --- | --- |
| Recover all worktrees | Integrator | Archived 31 missing worktree metadata sets, reflogs and original plans; master current. Seven distinct candidate heads remain subject to selective review. |
| First-person pipeline | Integrator | Recovered `fc6d49b` as `0c1b93a`; regenerated current derivatives in `8b5f64c`. 3 extraction tests pass, 5472 assertions. Native shotgun ADS screenshot fails sleeve/framing review; not accepted. |
| Receive-only voice | Voice worker | Integrated `1cb04d35`; 37 pinned voice/server tests pass. Browser fixtures cover denied/missing/ended mic and same-meeting recovery; new live SFU validation still outstanding. |
| Texture quality profiles | Art worker | Integrated `5aaad0f`; explicit preservation/high/low profiles, four tests pass. Hero authoring quality still open. |
| Duel parity | Duel worker | Integrated `a2cb5046`, offline TipHat `3d5ff13b`; 240 integrated tests pass. Native Underboss/Boss probe passed in worker; final TipHat review and original side-by-side remain. |
| Characters/material coverage | Queued | All outfits, paired fits, 17 outlaws, crowds and actual lighting coverage required. |
| Animals | Integrator | Recovered horse candidates in `906df7ff`/`9fc1b6a1`; retained prior texture bytes. Native review open; crow fold still open. |
| Environment | Queued | Siding, adobe, crates, terrain, flora, structure and interiors; preserve collision or version coordinated changes. |
| Lighting/effects | Queued | Calibrated materials, native tiers and full scene/day-night review. QA camera candidate `958f6b9` is not a lighting upgrade. |
| Audio | Integrator | Recovered candidates; `5e1fe2a6` adds post-limiter headroom. Ordinary/cluster peaks -2.6/-2.5 dBFS. Dense-firefight automated listening median 3/10: unaccepted. Reverted a mix experiment with no improvement. |
| Performance | Queued | Visible release-engine simulator/Chrome recorder; 60-second active runs, both orientations, ordinary and 32-player stress; retain every slow frame. |
| Delivery | Queued | Full check/build/native probes, immutable old assets, current hashes/previews, exact Worker then Pages revision verification. |

## Swarm rules

One integrator plus three workers, exclusive file ownership and isolated durable worktrees. Single Blender authoring lane. Integrator owns generated shared manifests and release. No production promotion until native visual/audio acceptance and appropriate tests pass. Do not mark TODO checkboxes complete from this ledger alone.

## Outstanding qualification

All 18 originally unchecked TODO items retain their acceptance requirements. Complete arm runtime lifecycle, masks, shadows, framing, action timing and Dead-Eye; material/animal/environment/parity work; receive-only voice; all four performance requirements; final source/content review and verified release. Reassess checked art/audio work against the photoreal direction.

Current diagnostics live under `/tmp/out-west-*`; archive accepted evidence durably before release. The first-person probe was initially invalidated by concurrent asset regeneration/HMR and is being rerun on stable files. Simulator results do not establish physical-phone performance.

Pinned Bun 1.3.14 broad candidate suite: 369 pass, zero failures. Host Bun 1.4.4 produced default-timeout failures and is not the qualification runtime. First-person portrait and landscape probes passed the initial candidate but visual framing failed. Follow-up lifecycle fix `7732e72f` needs the worker's disabled-socket readiness correction and native rerun before acceptance. Asset author is creating FP-only hand-contact-preserving pose variants with headless Blender. Duel worker is repairing the stale seated-anchor probe (actual seated pose/seatY contract) before performance recorder work. `c1830ca` adds tested timing summaries retaining empty seconds and stalls; it does not complete visible simulator/Chrome qualification.
