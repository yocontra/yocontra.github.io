# Out West remaining work

Last verified game release: `c3db37d` (2026-11-09). Map grounding, terrain cliffs, scenery support, character cuffs/coats/shirt fronts, native shot effects, duplicate rifle LOD removal, and lazy voice are shipped. This list tracks unfinished work; it is not a claim that final visual or performance QA is complete.

## Resume points

- Unfinished code is preserved **locally**, not deployed, on branch `wip/out-west-first-person-20261109`, commit `98b34bc`. It contains the ADS/viewmodel and grip-authoring prototypes. Do not merge it wholesale: only two prototype viewmodel descriptors exist, and long-gun art has not passed.
- Local scratch evidence lives under `/tmp/out-west-first-person-arms`, `/tmp/out-west-ads-*`, `/tmp/out-west-longgun-grips*`, and `/tmp/out-west-ground-performance`. These are optional resume aids, not durable production inputs. Rebuild anything missing from the canonical repository assets.

## Performance

- [ ] Finish visible iPhone 13 mini **simulator** and real Chrome measurements. The Mac was locked at the last check; no final FPS result was accepted. A physical phone is not required.
- [ ] Refresh the performance harness against the final immutable commit. Run at least 60 seconds of active movement, aiming, firing, glass hits, death and respawn with audio running. Cover normal portrait/landscape, an ordinary lobby and 32-player stress; target minimum 30 FPS in the simulator and approximately 60 FPS in Chrome.
- [ ] Record every one-second FPS bin, frame-time percentiles/max, loaded model/resource counts and foreground evidence throughout. Exclude respawn teleports from walking-distance evidence, not slow frames from timing.
- [ ] Optimize measured bottlenecks using native batching/material/cache/render features. Preserve foliage, scene definition and PBR. The earlier 34.1 FPS result at a small 812×265 viewport was an intermediate diagnostic, not final qualification.

## First-person models and aiming

- [ ] Complete the arms-only native viewmodel pipeline from the WIP branch. The offline extractor preserves fitted sleeves/hands, skinning, clips and shared PBR; default and wool-duster prototypes exist, and 34 fits passed CPU extraction checks. Public production derivatives have not been promoted.
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

- [ ] Review and ship the native `app.loader.enableRetry(3)` change preserved in WIP. Verify a real KTX 503→success path and terminal-failure cleanup; one live texture fetch transiently returned 503 before retrying to the correct bytes. Use the engine retry facility, not a custom retry loop.
- [ ] Finish simulator Safari voice permission/retry, receive/deafen and background/resume checks. Desktop actual SDK/SFU two-way decoding and complete provider cleanup passed before voice enablement.
- [ ] Preserve zero RTK allocation while voice is off, idle, alone or bot-only. Keep the rolling reservation guard and durable cleanup. The 9,000-minute reservation allowance is an operational guard, not a provider-enforced hard billing cap.

## Final delivery

- [ ] Review the finished source, then regenerate asset descriptors and native shop previews. Keep all 94 historical GLBs immutable and verify every new asset URL/hash.
- [ ] Run `bun run check` and the relevant native visual/lifecycle probes. Push and verify the actual Worker and site deployment; distinguish simulator results from untested hardware behavior.
