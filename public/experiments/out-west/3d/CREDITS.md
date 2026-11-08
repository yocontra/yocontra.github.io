# out west (3D) — credits

Software copyright and license texts: [third-party notices](../THIRD_PARTY_NOTICES.txt).

Game, code, wanted posters, town, church, water tower, hats, sky and effects by Eric Schoffstall.
The title and boss themes (`music/title.m4a`, `music/boss.m4a`) are the 2019 originals (`intro.m4a`,
`boss.m4a`), remastered and looped; `sfx/shout.m4a` and `sfx/whip.m4a` are remastered 2019 originals
too.

Every third-party asset below is CC0 (public domain). No attribution is legally required; it is
given anyway. All models were downloaded as GLB, trimmed and recompressed (meshopt + WebP).

## Characters (Quaternius, CC0)

Every base body (`models/{player,casual,worker,suit,rugged,king,punk,woman}.glb`) and the shared
character atlas (`tex/char_{diff,nor,arm}.webp`) are built by `tools/build-characters.ts` from the
free (standard) editions of three Quaternius packs, all CC0 1.0 (licence files in the downloads):

| Pack | Source | Used for | Licence |
|---|---|---|---|
| Universal Base Characters [Standard] | https://quaternius.com/packs/universalbasecharacters.html (https://quaternius.itch.io/universal-base-characters) | heads, faces, eyes, brows, hairstyles, beards (Superhero male/female bodies; only the head is kept) | CC0 1.0 |
| Modular Character Outfits – Fantasy [Standard] | https://quaternius.com/packs/modularcharacteroutfitsfantasy.html (https://quaternius.itch.io/modular-character-outfits-fantasy) | the Peasant and Ranger outfits (shirts, sleeves, trousers, boots, belts, bracers, pauldron), mixed and matched per base on their shared skeleton | CC0 1.0 |
| Universal Animation Library [Standard] | https://quaternius.com/packs/universalanimationlibrary.html (https://quaternius.itch.io/universal-animation-library) | every clip (idle, walk, jog, pistol idle/aim/shoot, hit, death...), renamed to the game's clip names | CC0 1.0 |

The parts are rebound to one skeleton, simplified with meshoptimizer to ~14–18k triangles a
body, and their textures (4K/2K) are packed into one 2048×3072 atlas (normal and ARM at half
size; AO baked into the albedo). The ranger set's forest green is recoloured to western colours
at runtime, and each outlaw's garment colours recolour only the main fabric of each garment
(mask from the texture). Hats, coats, ponchos, bandanas, masks, bandoliers, moustaches, stars
and holsters are procedural, fitted to each body and woven from the Poly Haven fabric swatches
below.

Frontier's move clips (`models/moves.glb`: sprint, crouch idle and walk, jump start / loop / land,
pistol reload, pistol aim up and down) are built by `tools/build-moves.ts` from the same Universal
Animation Library [Standard] (CC0 1.0), retargeted the same way. That copy of `UAL1_Standard.glb`
came from a mirror of the unmodified pack: https://raw.githubusercontent.com/DyingStar-game/DyingStar/HEAD/assets/Universal%20Animation%20Library/Unreal-Godot/UAL1_Standard.glb

Quaternius: https://quaternius.com

## Props and building kit (`models/props.glb`, `tex/kit_*.webp`)

Built by `tools/build-props.ts`: every kit piece below is re-UV'd into one trim atlas
(`tex/kit_{diff,nor,arm}.webp`, the kits' trim sheets stacked in bands) and draws with one
material; the street and the Frontier town merge their doors, windows, shutters, balcony rails and
dressing into one draw. The source of the untouched scenes is `tools/art/props-src.glb`.

| Prop | Source | Licence |
|---|---|---|
| Doors, door frames, windows, shutters, boardwalk planks, balcony rails, porch braces, fences, the wagon (`cart`), crates (`crate`), and the trim sheets `T_WoodTrim`, `T_MetalOrnaments` | Quaternius, "Medieval Village MegaKit" [Standard] — https://quaternius.com/packs/medievalvillagemegakit.html (https://quaternius.itch.io/medieval-village-megakit) | CC0 1.0 |
| Barrels (`barrel`), benches, buckets, chests, sacks, coin purses, coin piles, tables, chairs, stools, barrel racks, rope, wall lanterns, bottles, crates, anvil, workbench, and the trim sheets `T_Trim_Furniture`, `T_Trim_Metal`, `T_Trim_Props`, `T_Trim_Cloth` | Quaternius, "Fantasy Props MegaKit" [Standard] — https://quaternius.com/packs/fantasypropsmegakit.html (https://quaternius.itch.io/fantasy-props-megakit) | CC0 1.0 |
| Revolver (re-UV'd onto the atlas's steel and walnut) | Quaternius — https://poly.pizza/m/E7IaG9TptR | CC0 1.0 |
| Rifle | Quaternius — https://poly.pizza/m/KjHL5JJrxU | CC0 1.0 |
| Cactus | Quaternius — https://poly.pizza/m/HsEJgRLQWX | CC0 1.0 |
| Rock | Quaternius — https://poly.pizza/m/li0YBlBEMz | CC0 1.0 |
| Hay | Quaternius — https://poly.pizza/m/Yu8TOERkpw | CC0 1.0 |
| Coffin | Kay Lousberg — https://poly.pizza/m/WqqeFNrp0e | CC0 1.0 |
| Post lantern | Kay Lousberg — https://poly.pizza/m/ZSQ65S4lEu | CC0 1.0 |
| Hanging lantern | Kay Lousberg — https://poly.pizza/m/3jzk3YShv1 | CC0 1.0 |

The earlier Quaternius crate, barrel, broken cart and fence (poly.pizza 3OEFd1AWfa, ONdghDBByN,
NBDHe8J7f9, U7g0Wxpt63; CC0) were replaced by the kit pieces above.

## Town animals (`models/horse.glb`, `models/dog.glb`)

The horses at the hitching rails and the dog on the barber's porch. Downloaded from Poly Pizza as
GLB, trimmed to the idle clips the street uses (horse: Idle, Idle_2, Idle_Headlow, Eating,
Idle_HitReact_Left; dog: Idle, Idle_2_HeadLow, Eating, Attack), quantised and meshopt-compressed
with gltf-transform. At runtime each animal's flat-colour parts are merged into one skinned mesh
(one draw), the second horse is recoloured grey, and the horses get a procedural saddle and
blanket (`scene/beasts.ts`). The crows, chickens, screen door and hanging signs are procedural.

| Model | Source | Licence |
|---|---|---|
| Horse (animated) | Quaternius, from the Ultimate Animated Animals pack — https://poly.pizza/m/qvTrSG9pZF | CC0 1.0 |
| Shiba Inu (animated) | Quaternius, from the Ultimate Animated Animals pack — https://poly.pizza/m/y4wdQpg767 | CC0 1.0 |

## Textures (Poly Haven, CC0)

Each set ships diffuse, OpenGL normal and ARM (ambient occlusion, roughness, metalness) maps at 1K,
fetched and converted to WebP with `tools/polyhaven.ts`.

| File | Source | Licence |
|---|---|---|
| `tex/ground_*.webp` | "Gravelly Sand" — https://polyhaven.com/a/gravelly_sand | CC0 1.0 |
| `tex/planks_*.webp` | "Weathered Plank Siding" — https://polyhaven.com/a/weathered_plank_siding | CC0 1.0 |
| `tex/vplanks_*.webp` | "Old Planks 02" — https://polyhaven.com/a/old_planks_02 | CC0 1.0 |
| `tex/char_*.webp` swatches: leather | "Brown Leather" — https://polyhaven.com/a/brown_leather | CC0 1.0 |
| swatch: wool (coats) | "Caban" — https://polyhaven.com/a/caban | CC0 1.0 |
| swatch: felt (hats, moustaches) | "Scuba Suede" — https://polyhaven.com/a/scuba_suede | CC0 1.0 |
| swatch: linen (bandanas, masks) | "Rough Linen" — https://polyhaven.com/a/rough_linen | CC0 1.0 |
| swatch: hessian (ponchos) | "Hessian 230" — https://polyhaven.com/a/hessian_230 | CC0 1.0 |
| `tex/civic_*.webp` (clock tower atlas): brick | "Red Brick" — https://polyhaven.com/a/red_brick | CC0 1.0 |
| civic atlas: dressed stone | "Sandstone Blocks 08" — https://polyhaven.com/a/sandstone_blocks_08 | CC0 1.0 |
| civic atlas: cedar shingles | "Roof Slates 02" — https://polyhaven.com/a/roof_slates_02 | CC0 1.0 |
| civic atlas: sheet tin | "Rusty Metal Sheet" — https://polyhaven.com/a/rusty_metal_sheet | CC0 1.0 |

The civic atlas packs those four sets 2x2 with wrapped gutters (`tools/build-civic-atlas.ts`):
diffuse 1024², normal and ARM 512². The clock dial is painted at runtime on a canvas.

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
| `music/victory_big.m4a`, `music/victory_lucky.m4a` | Graded victory stings: the LIGHTNING/DEADEYE fanfare, the LUCKY harmonica |
| `voice/*.m4a` (15 of the outlaws) | Outlaw barks: the captioned lines and death grunts, ElevenLabs `eleven_v3` with premade voices (cast in `tools/audio/voices.ts`) |

`sfx/ui_tick.m4a` is synthesised (first-party).

### Generated (Google: Lyria 2 and Gemini TTS, Vertex AI), first-party

Prompts are in `tools/audio/manifest.ts` (music) and `tools/audio/voices.ts` (voices).

| File | What |
|---|---|
| `music/saloon.m4a` | Saloon hub bed, honky-tonk piano (Lyria 2, looped on whole bars) |
| `music/act_day.m4a`, `music/act_dusk.m4a`, `music/act_night.m4a` | The three act themes (Lyria 2, looped on whole bars) |
| `music/act_*_hot.m4a` | The act themes with the win-streak layer: a synthesised galloping percussion track laid on their beat grid (`tools/audio/beats.ts`) |
| `voice/impatient.m4a`, `voice/player.m4a` | Salvador's voice and the player's breaths and grunts (Gemini TTS) |

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
| `paper.webp` (768², 45 KB), `leather.webp` (768², 83 KB), `smoke.webp` (768², 8 KB) | Cotton rag handbill stock, worn saddle leather, smoke-darkened endpaper: generated (Gemini, 2026-11 art pass), made seamless with `tools/seamless.ts` | First-party |
| `poster.webp`, `wood.webp` | Wanted-poster stock, saloon planks: generated (Gemini), resized and compressed | First-party |
| `seal.webp` | Red wax seal: generated (Gemini), chroma-keyed | First-party |
| `title-duel.svg` (100 KB, 34 KB gzipped) | Title key art: the duel street at noon (the courthouse clock tower, false fronts, mesas, two gunmen) as a two-ink relief print. Drawn by hand as geometry in `tools/build-title-art.ts` (true one-point perspective, no image generator, no lettering); ink spread, wear and misregistration are SVG filters | First-party |
| `corner.svg`, `rule.svg`, `src/experiments/out-west/ui/icons.ts` | Printer's ornaments and the 12-icon set: generated (Gemini) as raster references, traced to vectors with potrace | First-party |
| `torn.svg` | Torn paper edge mask: generated procedurally | First-party |

## Fonts (self-hosted, `/experiments/out-west/fonts/`, built by `tools/build-fonts.ts` from github.com/google/fonts; licence texts alongside)

- "Ultra" by Astigmatic (AOETI), Apache License 2.0.
- "Rye" by Nicole Fally (Sorkin Type Co), SIL Open Font License 1.1.
- "EB Garamond" by Georg Duffner and Octavio Pardo, SIL Open Font License 1.1.
- "Oswald" by Vernon Adams, Kalapi Gajjar and Cyreal, SIL Open Font License 1.1.

## PlayCanvas migration bakes

`baked/{frontier,duel}.glb` bake the Out West town geometry and the credited Quaternius props
and Poly Haven texture sources above into standard glTF. `baked/player.glb` and
`baked/outlaw-{0..16}.glb` bake the credited Quaternius character bases and animations together
with Out West's fitted western clothing, hats and accessories. `baked/moves.glb` is a decoded
standard-glTF copy of the existing movement animation library. No new external art or license
was introduced by the migration. Embedded textures are resized and encoded as WebP.

`env/kloppenheim_06_puresky_1k.hdr`: **Kloppenheim 06 (Pure Sky)** by Greg Zaal
(original) and Jarod Guest (sky edits), Poly Haven, **CC0**.
Source: https://polyhaven.com/a/kloppenheim_06_puresky
License: https://polyhaven.com/license

`baked/{depot,mission,bank}.glb` preserve Out West's authored rail-depot, mission courtyard
and bank square, with the same credited masonry, props and texture sources. Legacy atlas
selector UVs are flattened offline into ordinary repeating PBR material tiles.
`equipment/*.glb` preserve all 37 catalogue guns, hats, outfits, spurs, holsters and extras
with standardized rigs or bone mounts. `dynamic/*.glb` preserve pickups, saddlebags and the
strongbox, plus authored coin/card/crow/tumbleweed/door fake-out clips and the credited CC0
Quaternius animated dog and horse. Cue transform clips are first-party animation.
