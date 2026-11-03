# out west (3D) — credits

Game, code, wanted posters, town, church, water tower, hats, sky and effects by Eric Schoffstall.
Music (`intro.m4a`, `boss.m4a`) and the original sounds (`cocking`, `fire`, `fire-big`, `shout`,
`whip`) are from the 2019 original.

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

## Generated textures

| File | Source | Licence |
|---|---|---|
| `tex/signboard_nor.webp`, `tex/signboard_arm.webp` | Weathered painted signboard: generated (Gemini), source `tools/art/signboard_src.webp`; normal and ARM derived with `tools/pbr-from-albedo.ts` | First-party |

## Font

"Alfa Slab One" by JM Solé, SIL Open Font License 1.1 — https://fonts.google.com/specimen/Alfa+Slab+One
