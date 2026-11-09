# Out West remaining work

Last verified site release: `8e6c916` (2026-11-09; public client revision checked). It includes the earlier map/model/voice repairs plus Frontier haze, Live town/voice controls, spectator isolation and restored special-duel rules. Later completed tasks below may still be deploying. This list tracks unfinished work; it is not a claim that final visual or performance QA is complete.

## Current playtest feedback (2026-11-09)

Complete and push these in small working tasks, with native visual/audio evidence for each affected path.

- [ ] Run a side-by-side duel-mode parity audit against the original engine version. Capture matching campaign scenes, introductions/dialogue, idle/draw/shoot/death animations, timing, gameplay cues, transitions, UI feedback and microinteractions. Record each missing or degraded detail as an actionable fix with before/after visual evidence; do not treat a render-only comparison as gameplay parity.
- [ ] Restore original duel balance wherever the engine migration changed it. Compare canonical pre-rewrite reaction windows, opponent draw/shoot timing, accuracy/misses, damage, modifiers and progression with deterministic behavioral checks. Preserve original balance rather than introducing a new difficulty tuning pass.
- [x] Restore confirmed controller drift: zero Legend jitter, original boss-phase-two jitter, automatic rifleman-first Underboss targeting and the 100 ms second-target gap. Six deterministic tests drive production call/shoot paths; unchanged roster/judge data does not establish complete ordinary-duel parity.
- [x] Repair the station roof: correct six roof triangles and two underside triangles in canonical/native assets. Native above/below captures show complete roofing and boarded undersides; all other faces, UVs/materials and the 94 historical public GLBs are unchanged.
- [x] Remove inherited street-shop signs from depot, mission and bank scenes. Native scene cycling verifies six street signs are visible only on the street, each arena retains its own signs/props, shared scenery stays intact and returning to the street restores its dressing. Bank lantern proportions remain a separate task.
- [ ] Fix oversized, unlit lantern street signs in the First National Bank scene. Replace them with properly proportioned fixtures with actual night lighting, or remove fixtures that do not fit the scene. Verify daylight/night appearance and native light/render cost.
- [x] Present the next map and opponent atomically with a loading state until the scene, actors, attachments and lighting are ready. New actors enter disabled; thirteen deferred lifecycle tests and three mounted native slow-load/cancellation cases cover stale completion, partial failure, retry and disposal.
- [x] Isolate duel spectators from combat transitions. Remove synchronized human flinch/duck/run overrides; nine native spectators retain their own clips, poses and positions through DRAW, shooting and outcomes while the opponent and animal/bird reactions continue. Native checks confirm independent skeleton/controller ownership with shared meshes.
- [ ] Make moving tumbleweeds roll with their travel direction/distance and actual radius, preserving ground contact and ambient-path timing.
- [ ] Correct plastic-looking character materials: skin, cloth and fabric need appropriate roughness, metalness and specular response. Check every outfit and crowd material under actual game lighting.
- [ ] Repair missing rear-neck geometry/seams and forward-hunched head/neck posture on player, opponents and crowds. Compare bind pose and animated poses before changing the rig.
- [ ] Fix the main-screen idle glitch: approximately every four seconds, a roughly 200 ms arms-forward pose interrupts idle. Verify a continuous animation capture across several loops.
- [ ] Restore the horse's textures and validate its actual native render, not only material metadata.
- [ ] Replace thick, clog-like boot soles and knee-high generic shapes with properly proportioned cowboy boots. Preserve fitted garment boundaries and review all affected fits.
- [x] Add distance haze that obscures far hills and foliage while retaining nearby combat readability: native Frontier fog now spans 25–110 m. Matched native renders preserve scene resources and near detail; day/night colors and dense Daily fog remain intact.
- [ ] Restore appropriate distance haze in campaign duels too. Current distant fog presets were carried over without the original engine's additional atmosphere shader; tune native fog at the actual duel/depot/mission/bank cameras while preserving opponent visibility and Daily fog.
- [x] Make the wanted poster respond to lighting/shadows as nonemissive printed paper. A reused, properly scaled Kit lantern and one bounded native night light keep it readable across all four arenas. Native day/shadow/night checks preserve existing geometry/UVs/textures and verify light cleanup; no global ambient lift or extra shadow map.
- [ ] Correct squashed barrels, cacti and other distorted props at their source/placement transforms. Preserve natural proportions and matching gameplay collision.
- [ ] Improve cactus and environment model/texture fidelity; replace shiny generic gradients with appropriate authored surface detail. Use detailed source meshes and native LOD where useful, measuring the 30 FPS simulator / approximately 60 FPS Chrome budget before promoting assets.
- [x] Make **Live town** the first and primary Frontier CTA, retaining sign-in/licence handling and secondary practice access.
- [ ] Fix Perdition reloading/navigating when microphone permission is granted. Add a usable microphone selector after permission where browser device enumeration supports it, and handle default-device changes.
- [x] Hide desktop **TALK** while retaining keyboard push-to-talk, connection/retry and open-mic mute controls. Keep mobile touch TALK with correct modality hints and active talking status; actual component browser checks cover both inputs.
- [ ] Make broken glass visibly fragment and fall away, with a glass shatter sound. Bound native debris lifetime/count and verify collision/cleanup and performance.
- [ ] Add distinct positional bullet-hit sounds for people, wood, masonry/concrete, metal, glass and other authored surfaces. Match actual hit material and avoid duplicate local/authoritative playback.
- [ ] Correct floaty jumping toward the requested Call of Duty Mobile feel. Tune native gravity/impulse together, retain one jump edge, and verify local/server trajectories and traversal routes.
- [ ] Add positional footsteps for every nearby player using the actual supporting surface, including stairs and vertical separation. Validate proximity, obstruction, cadence and cleanup so approaching players are audible without hearing the whole map.

## Resume points

- Unfinished code is preserved **locally**, not deployed, on branch `wip/out-west-first-person-20261109`, commit `98b34bc`. It contains the ADS/viewmodel and grip-authoring prototypes. Do not merge it wholesale: only two prototype viewmodel descriptors exist, and long-gun art has not passed.
- Local scratch evidence lives under `/tmp/out-west-first-person-arms`, `/tmp/out-west-ads-*`, `/tmp/out-west-longgun-grips*`, and `/tmp/out-west-ground-performance`. These are optional resume aids, not durable production inputs. Rebuild anything missing from the canonical repository assets.

## Performance

- [ ] Finish visible iPhone 13 mini **simulator** and real Chrome measurements. The Mac was locked at the last check; no final FPS result was accepted. A physical phone is not required.
- [ ] Refresh the performance harness against the final immutable commit. Run at least 60 seconds of active movement, aiming, firing, glass hits, death and respawn with audio running. Cover normal portrait/landscape, an ordinary lobby and 32-player stress; target minimum 30 FPS in the simulator and approximately 60 FPS in Chrome.
- [ ] Record every one-second FPS bin, frame-time percentiles/max, loaded model/resource counts and foreground evidence throughout. Exclude respawn teleports from walking-distance evidence, not slow frames from timing.
- [ ] Optimize measured bottlenecks using native batching/material/cache/render features. Preserve foliage, scene definition and PBR. The earlier 34.1 FPS result at a small 812×265 viewport was an intermediate diagnostic, not final qualification.

## First-person models and aiming

- [x] Recover the bounded offline arms extractor (`tools/content/first-person-arms.ts`). Trail-duds and wool-duster CPU checks preserve native triangles/typed streams, full PBR and external texture URLs, skeleton/TRS/IBMs and humanoid clips; provenance includes authored garments and shared helpers. Repeated staging outputs are byte-identical and remain temporary.
- [ ] Complete the arms-only native viewmodel runtime pipeline from the WIP branch. Current extraction acceptance covers trail-duds and wool-duster; public production derivatives have not been promoted.
- [ ] Generate and validate all required fits, descriptors and content hashes. Exclude head, torso, legs, accessories and stale embedded weapon mounts; preserve complete humanoid joints and both hands/weapons for paired mode. Do not substitute one generic sleeve/skin for every outfit.
- [ ] Keep the physical world actor at its gameplay pose for shadows. Only the separate local arms actor receives first-person/ADS transforms. Use native forward-pass masking, preserve exact mask restoration, and opt local world/arms attachments out of shared rigid batching.
- [ ] Finish one active arms actor plus one serialized disabled pending replacement. Handle appearance/gun/life changes, cancellation, late attachments and disposal without flashes or leaked actors/textures. Arms cast no shadows; world-body shadows continue animating.
- [ ] Finish long-gun framing. The rejected whole-body approach exposed torso/head geometry. Arms-only forward offset 0.15 m looked more promising; 0.30 m exposed shoulder cut ends. Review portrait and landscape before choosing final profiles.
- [ ] Correct shotgun right-index obstruction: actual Index2R/Index3R skin intersects the sight line ahead of the rear rib. Projected sight landmarks alone are not a visual pass. Do not hide fingers to conceal this.
- [ ] Finish ADS enter/exit, paired-gun behavior and all action/lifecycle proofs. Preserve physical camera eye within 1e-6 m and the authoritative shot ray. Preserve full 200 ms firing animation; resume settled native layers before movement, jump, stance, firing, reload, weapon/life/view changes or loss of readiness.
- [ ] Preserve Dead-Eye charge/readiness feedback. The gold reticle ring is an existing mechanic, not an ADS zoom indicator.

## Long-gun hand poses

- [ ] Replace the poor support-hand pose using the canonical weapon-specific donor or a bounded offline native Blender arm/hand pose. The original `held-actions` finger planes run along the barrel, so small curl changes alone cannot produce a natural wrap.
- [ ] Start with `tools/art/characters/held-rifle.gltf` as a donor reference. Its support-hand placement is about 108 mm different from the current action pose and has much better finger contact. Retarget deliberately; preserve right/body/gun channels and original clip timing wherever possible.
- [ ] Validate actual skinned pads, axial twist, self-folding and comfortable silhouette across Hold/Shoot/crouch, including the full 200 ms action. Rejected prototypes achieved good fingertip distances or shallow penetration while still producing visibly twisted fingers. None were promoted.
- [ ] Finish rifle first, then shotgun support hand and the separate shotgun trigger-index correction. Keep runtime IK/solvers out of the game; bake authored poses and reuse native animation.

## Loading and voice QA

- [x] Verify existing native asset retries: PlayCanvas `AppBase.init` already enables five retries, so no override is needed. `bun tools/content/asset-retry.ts` verifies real WebGL/KTX2 recovery after five HTTP 503s, terminal failure after six attempts, failed-load eviction and re-acquisition, texture/application cleanup, and a disabled-retry control.
- [ ] Finish simulator Safari voice permission/retry, receive/deafen and background/resume checks. Desktop actual SDK/SFU two-way decoding and complete provider cleanup passed before voice enablement.
- [ ] Preserve zero RTK allocation while voice is off, idle, alone or bot-only. Keep the rolling reservation guard and durable cleanup. The 9,000-minute reservation allowance is an operational guard, not a provider-enforced hard billing cap.

## Final delivery

- [ ] Review the finished source, then regenerate asset descriptors and native shop previews. Keep all 94 historical GLBs immutable and verify every new asset URL/hash.
- [ ] Run `bun run check` and the relevant native visual/lifecycle probes. Push and verify the actual Worker and site deployment; distinguish simulator results from untested hardware behavior.
