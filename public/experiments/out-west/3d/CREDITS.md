# out west (3D) — credits

Game, code, wanted posters, town, church, water tower, hats, sky and effects by Eric Schoffstall.
The title and boss themes (`music/title.m4a`, `music/boss.m4a`) are the 2019 originals (`intro.m4a`,
`boss.m4a`), remastered and looped; `sfx/shout.m4a` and `sfx/whip.m4a` are remastered 2019 originals
too.

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

## Sound effects and music

Everything here is mastered by `tools/audio/build.ts` (recipes in `tools/audio/recipes.ts`): 48 kHz,
AAC-LC `.m4a` (Apple encoder), SFX and beds to about −16 LUFS and music to −18 LUFS, true peak
≤ −1 dBTP. Prompts for every generated take are in `tools/audio/manifest.ts`.

### Generated (ElevenLabs), first-party

| File | What |
|---|---|
| `sfx/rev_close.m4a`, `sfx/rev_tail.m4a` | Revolver: close crack (plus a synthesised sub punch) and the stereo town tail (layered at runtime) |
| `sfx/cock.m4a`, `sfx/hammer.m4a`, `sfx/holster.m4a` | Hammer cock, dry-fire hammer, leather quick-draw |
| `sfx/rifle.m4a`, `sfx/rifle_lever.m4a` | Lever-action rifle shot and lever |
| `sfx/shotgun.m4a`, `sfx/shotgun_load.m4a` | Coach gun blast and break-open reload |
| `sfx/fuse.m4a`, `sfx/explosion.m4a` | Dynamite fuse (seamless loop) and blast (two takes layered) |
| `sfx/hit_body.m4a`, `sfx/hit_wood.m4a`, `sfx/hit_dirt.m4a`, `sfx/ricochet.m4a` | Bullet impacts |
| `sfx/dirtsteps.m4a`, `sfx/woodsteps.m4a`, `sfx/spursteps.m4a` | Boots on dirt and boardwalk, spur jingles (sliced onto fixed grids) |
| `sfx/amb_wind_day.m4a`, `sfx/amb_wind_dusk.m4a`, `sfx/amb_wind_night.m4a` | Wind beds by time of day (seamless, streamed) |
| `sfx/amb_crickets.m4a`, `sfx/amb_saloon.m4a`, `sfx/amb_piano.m4a` | Night crickets, saloon murmur, honky-tonk piano (seamless, streamed) |
| `sfx/crow.m4a`, `sfx/dog.m4a`, `sfx/heart.m4a` | Crows, distant dog, heartbeat (plus a synthesised sub) |
| `sfx/coins.m4a`, `sfx/register.m4a`, `sfx/deposit.m4a` | Coins, cash register (no bell), bank deposit and vault |
| `sfx/ui_paper.m4a`, `sfx/ui_stamp.m4a`, `sfx/ui_buy.m4a`, `sfx/queue_found.m4a`, `sfx/levelup.m4a` | UI: paper slide, stamp, purchase, queue found, level-up sting |
| `sfx/ghost.m4a`, `sfx/ghost_vanish.m4a`, `sfx/respawn.m4a` | Ghost duel reveal and vanish, Frontier respawn |
| `music/tension.m4a`, `music/frontier.m4a` | Standoff tension bed and Frontier town loop (seamless, pitched into A) |
| `music/victory.m4a`, `music/defeat.m4a` | Victory and defeat stings |

`sfx/ui_tick.m4a` is synthesised (first-party).

### freesound.org, CC0 (trimmed, mono, remastered)

| File | Source | Licence |
|---|---|---|
| `sfx/bell.m4a` | "church bells strike 12 midday" by Astounded — https://freesound.org/s/481969/ (the canonical call; unchanged) | CC0 1.0 |
| `sfx/flyby.m4a` | "Real Bullet Flyby Sound" by qubodup — https://freesound.org/s/855248/ | CC0 1.0 |
| `sfx/bodyfall.m4a` | "BODY FALL - V HVY - DIRT" by leonelmail — https://freesound.org/s/504626/ | CC0 1.0 |
| `sfx/gasp.m4a` | "CRWDReac_Crowd Gasping In Surprise, Voiced 02" by ShangusBurger — https://freesound.org/s/763993/ | CC0 1.0 |
| `sfx/door.m4a` | "Saloon Door Squeak" by forfie — https://freesound.org/s/364991/ ; "Wood Door Slam.wav" by MootMcnoodles — https://freesound.org/s/444409/ | CC0 1.0 |
| `sfx/bottle.m4a` | "Small Bottle Smash FF223.aif" by martinimeniscus — https://freesound.org/s/199401/ | CC0 1.0 |
| `sfx/horse.m4a` | "horse neigh shortened.wav" by shadoWisp — https://freesound.org/s/269571/ | CC0 1.0 |
| `sfx/coin.m4a` | "Singular Coin Dropping.wav" by Flem0527 — https://freesound.org/s/630018/ | CC0 1.0 |
| `sfx/piano.m4a` | "Saloon piano, honky tonk, interrupted" by vdublin — https://freesound.org/s/428150/ | CC0 1.0 |
| `sfx/hawk.m4a` | "Hawk,Cry,Bird,Ext.wav" by Framing_Noise — https://freesound.org/s/319619/ | CC0 1.0 |
| `sfx/amb_fire.m4a` | "Fire Crackle and Flames 002" by TheWoodlandNomad — https://freesound.org/s/363092/ (looped) | CC0 1.0 |

## Generated textures

| File | Source | Licence |
|---|---|---|
| `tex/signboard_nor.webp`, `tex/signboard_arm.webp` | Weathered painted signboard: generated (Gemini), source `tools/art/signboard_src.webp`; normal and ARM derived with `tools/pbr-from-albedo.ts` | First-party |

## UI art (`/experiments/out-west/ui/`)

| File | Source | Licence |
|---|---|---|
| `paper.webp`, `poster.webp`, `wood.webp`, `leather.webp`, `smoke.webp` | Aged paper, wanted-poster stock, saloon planks, saddle leather, charred endpaper: generated (Gemini), resized and compressed | First-party |
| `seal.webp` | Red wax seal: generated (Gemini), chroma-keyed | First-party |
| `duel-woodcut.webp` | Title woodcut of a street duel: generated (Gemini) | First-party |
| `corner.svg`, `rule.svg`, `src/experiments/out-west/ui/icons.ts` | Printer's ornaments and the 12-icon set: generated (Gemini) as raster references, traced to vectors with potrace | First-party |
| `torn.svg` | Torn paper edge mask: generated procedurally | First-party |

## Fonts (self-hosted via fontsource)

- "Ultra" and "Rye" by Astigmatic (AOETI), SIL Open Font License 1.1.
- "EB Garamond" by Georg Duffner and Octavio Pardo, SIL Open Font License 1.1.
- "Oswald" by Vernon Adams, Kalapi Gajjar and Cyreal, SIL Open Font License 1.1.
