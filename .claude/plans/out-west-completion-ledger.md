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
| Receive-only voice | Voice worker | Isolated `finish/receive-only-voice`; implementation and lifecycle tests underway. |
| Texture quality profiles | Art worker | Isolated `finish/art-pipeline`; explicit preservation/high/low profiles and tests underway. |
| Duel parity | Duel worker | Isolated `finish/duel-presentation`; restore missing beats without spectator reaction regression. Offline TipHat clip coordinated with art worker. |
| Characters/material coverage | Queued | All outfits, paired fits, 17 outlaws, crowds and actual lighting coverage required. |
| Animals | Queued | Review `69f444a` horse candidate; finish riding clips and crow wing fold. |
| Environment | Queued | Siding, adobe, crates, terrain, flora, structure and interiors; preserve collision or version coordinated changes. |
| Lighting/effects | Queued | Calibrated materials, native tiers and full scene/day-night review. QA camera candidate `958f6b9` is not a lighting upgrade. |
| Audio | Queued | Recover `c9143f4` tools/budgets selectively; dense-firefight sound remains unaccepted. |
| Performance | Queued | Visible release-engine simulator/Chrome recorder; 60-second active runs, both orientations, ordinary and 32-player stress; retain every slow frame. |
| Delivery | Queued | Full check/build/native probes, immutable old assets, current hashes/previews, exact Worker then Pages revision verification. |

## Swarm rules

One integrator plus three workers, exclusive file ownership and isolated durable worktrees. Single Blender authoring lane. Integrator owns generated shared manifests and release. No production promotion until native visual/audio acceptance and appropriate tests pass. Do not mark TODO checkboxes complete from this ledger alone.

## Outstanding qualification

All 18 originally unchecked TODO items retain their acceptance requirements. Complete arm runtime lifecycle, masks, shadows, framing, action timing and Dead-Eye; material/animal/environment/parity work; receive-only voice; all four performance requirements; final source/content review and verified release. Reassess checked art/audio work against the photoreal direction.

Current diagnostics live under `/tmp/out-west-*`; archive accepted evidence durably before release. The first-person probe was initially invalidated by concurrent asset regeneration/HMR and is being rerun on stable files. Simulator results do not establish physical-phone performance.
