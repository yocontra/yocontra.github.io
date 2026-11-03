# out west (3D) — credits

Game, code, wanted posters, town, church, water tower, hats, sky and effects by Eric Schoffstall.
Music (`intro.m4a`, `boss.m4a`) and the original sounds (`cocking`, `fire`, `fire-big`, `shout`,
`whip`) are from the 2019 original.

Every third-party asset below is CC0 (public domain). No attribution is legally required; it is
given anyway. All models were downloaded as GLB, trimmed and recompressed (meshopt + WebP).

## Characters (Quaternius, CC0, via Poly Pizza)

| File | Source | Licence |
|---|---|---|
| `models/player.glb` | "Farmer" by Quaternius — https://poly.pizza/m/7pn3R6hPvE | CC0 1.0 |
| `models/suit.glb` | "Business Man" by Quaternius — https://poly.pizza/m/JFrLIKqvCH | CC0 1.0 |
| `models/rugged.glb` | "Adventurer" by Quaternius — https://poly.pizza/m/5EGWBMpuXq | CC0 1.0 |
| `models/woman.glb` | "Adventurer" by Quaternius — https://poly.pizza/m/ZwF0K7WBmu | CC0 1.0 |
| `models/casual.glb` | "Casual Character" by Quaternius — https://poly.pizza/m/kZ3DmIoGip | CC0 1.0 |
| `models/worker.glb` | "Worker" by Quaternius — https://poly.pizza/m/Yg2bQZO6Hj | CC0 1.0 |
| `models/king.glb` | "King" by Quaternius — https://poly.pizza/m/I1gTjmuK2m | CC0 1.0 |
| `models/punk.glb` | "Punk" by Quaternius — https://poly.pizza/m/BTALZymknF | CC0 1.0 |

All of these share one rig (the Woman has her own). Each outlaw is ONE whole character from this
list, never parts of several: recoloured, uniformly scaled, and dressed at runtime in procedural
hats, coats, ponchos, bandanas, masks, bandoliers, beards, moustaches and badges that are fitted to
his own posed surface and skinned to his bones, then baked with him into a single skinned mesh.
The worker's hard hat, the king's crown, the punk's mohawk and the rugged adventurer's backpack are
removed. No fabric textures are used.

Quaternius: https://quaternius.com

## Props (`models/props.glb`, merged)

| Prop | Source | Licence |
|---|---|---|
| Revolver | Quaternius — https://poly.pizza/m/E7IaG9TptR | CC0 1.0 |
| Rifle | Quaternius — https://poly.pizza/m/KjHL5JJrxU | CC0 1.0 |
| Cactus | Quaternius — https://poly.pizza/m/HsEJgRLQWX | CC0 1.0 |
| Crate | Quaternius — https://poly.pizza/m/3OEFd1AWfa | CC0 1.0 |
| Barrel | Quaternius — https://poly.pizza/m/ONdghDBByN | CC0 1.0 |
| Broken cart | Quaternius — https://poly.pizza/m/NBDHe8J7f9 | CC0 1.0 |
| Rock | Quaternius — https://poly.pizza/m/li0YBlBEMz | CC0 1.0 |
| Hay | Quaternius — https://poly.pizza/m/Yu8TOERkpw | CC0 1.0 |
| Fence | Quaternius — https://poly.pizza/m/U7g0Wxpt63 | CC0 1.0 |
| Coffin | Kay Lousberg — https://poly.pizza/m/WqqeFNrp0e | CC0 1.0 |
| Post lantern | Kay Lousberg — https://poly.pizza/m/ZSQ65S4lEu | CC0 1.0 |
| Hanging lantern | Kay Lousberg — https://poly.pizza/m/3jzk3YShv1 | CC0 1.0 |

## Textures (Poly Haven, CC0)

Each set ships diffuse, OpenGL normal and ARM (ambient occlusion, roughness, metalness) maps at 1K,
fetched and converted to WebP with `tools/polyhaven.ts`.

| File | Source | Licence |
|---|---|---|
| `tex/ground_*.webp` | "Gravelly Sand" — https://polyhaven.com/a/gravelly_sand | CC0 1.0 |
| `tex/planks_*.webp` | "Weathered Plank Siding" — https://polyhaven.com/a/weathered_plank_siding | CC0 1.0 |
| `tex/vplanks_*.webp` | "Old Planks 02" — https://polyhaven.com/a/old_planks_02 | CC0 1.0 |

## Sound effects (freesound.org, CC0)

Trimmed, mono, normalised and re-encoded to AAC.

| File | Source | Licence |
|---|---|---|
| `sfx/bell.m4a` | "church bells strike 12 midday" by Astounded — https://freesound.org/s/481969/ | CC0 1.0 |
| `sfx/spursteps.m4a` | "R10-27-Boots with Spurs.wav" by craigsmith — https://freesound.org/s/480613/ | CC0 1.0 |
| `sfx/dirtsteps.m4a` | "Footsteps_6_Dirt_shoe.wav" by monte32 — https://freesound.org/s/353799/ | CC0 1.0 |
| `sfx/heart.m4a` | "heartbeat sub kick - softer" by music_is_wiggly_air — https://freesound.org/s/784658/ | CC0 1.0 |
| `sfx/ricochet.m4a` | "Ricochet 2.wav" by morganpurkis — https://freesound.org/s/392975/ ; "Ricochet 4.wav" by saturdaysoundguy — https://freesound.org/s/394187/ ; "ricochet.mp3" by cedarstudios — https://freesound.org/s/148840/ | CC0 1.0 |
| `sfx/flyby.m4a` | "Real Bullet Flyby Sound" by qubodup — https://freesound.org/s/855248/ | CC0 1.0 |
| `sfx/bodyfall.m4a` | "BODY FALL - V HVY - DIRT" by leonelmail — https://freesound.org/s/504626/ | CC0 1.0 |
| `sfx/gasp.m4a` | "CRWDReac_Crowd Gasping In Surprise, Voiced 02" by ShangusBurger — https://freesound.org/s/763993/ | CC0 1.0 |
| `sfx/crow.m4a` | "Crow Caw" by qubodup — https://freesound.org/s/813115/ | CC0 1.0 |
| `sfx/door.m4a` | "Saloon Door Squeak" by forfie — https://freesound.org/s/364991/ ; "Wood Door Slam.wav" by MootMcnoodles — https://freesound.org/s/444409/ | CC0 1.0 |
| `sfx/bottle.m4a` | "Small Bottle Smash FF223.aif" by martinimeniscus — https://freesound.org/s/199401/ | CC0 1.0 |
| `sfx/horse.m4a` | "horse neigh shortened.wav" by shadoWisp — https://freesound.org/s/269571/ | CC0 1.0 |
| `sfx/coin.m4a` | "Singular Coin Dropping.wav" by Flem0527 — https://freesound.org/s/630018/ | CC0 1.0 |
| `sfx/piano.m4a` | "Saloon piano, honky tonk, interrupted" by vdublin — https://freesound.org/s/428150/ | CC0 1.0 |
| `sfx/dog.m4a` | "Distant Dog Bark" by qubodup — https://freesound.org/s/813116/ | CC0 1.0 |
| `sfx/hawk.m4a` | "Hawk,Cry,Bird,Ext.wav" by Framing_Noise — https://freesound.org/s/319619/ | CC0 1.0 |
| `sfx/holster.m4a` | "Gun draw holster.wav" by huddwink — https://freesound.org/s/239959/ | CC0 1.0 |
| `sfx/wind.m4a` | "desert_wind.wav" by DarkShroom — https://freesound.org/s/645305/ | CC0 1.0 |
| `sfx/crickets.m4a` | "Outdoors_Night_CloseCrickets.wav" by MrFossy — https://freesound.org/s/521844/ | CC0 1.0 |
| `sfx/fire.m4a` | "Fire Crackle and Flames 002" by TheWoodlandNomad — https://freesound.org/s/363092/ | CC0 1.0 |

## Font

"Alfa Slab One" by JM Solé, SIL Open Font License 1.1 — https://fonts.google.com/specimen/Alfa+Slab+One
