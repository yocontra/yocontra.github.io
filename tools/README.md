# out west asset pipeline (`tools/`)

Bun + TypeScript, typechecked by `tsc -p tools` (part of `bun run check`). Owned by stream H;
reuse freely. Every third-party or generated asset gets a line in
`public/experiments/out-west/3d/CREDITS.md`.

| Tool                  | What it does                                                                                                                                                                                                             | Needs                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `polyhaven.ts`        | Fetch a Poly Haven CC0 PBR set (diffuse, GL normal, ARM, …) and write WebP maps                                                                                                                                          | `cwebp`                                                                        |
| `pbr-from-albedo.ts`  | Derive normal + ARM (AO, roughness) from a flat albedo (design doc §10.2): Gemini signage, posters, leather                                                                                                              | `ffmpeg`, `cwebp`                                                              |
| `optimize-gltf.ts`    | dedup → prune → weld → resize → KTX2 (or WebP) → quantize → meshopt, plus an optional simplified LOD file                                                                                                                | `bunx` (fetches `@gltf-transform/cli`), optional `toktx`                       |
| `build-characters.ts` | The textured character bases + clips + shared character atlas from Quaternius's CC0 Universal Base Characters, Modular Outfits – Fantasy and Universal Animation Library (see the file header)                           | the unzipped packs, `sharp`, gltf-transform, meshoptimizer                     |
| `build-props.ts`      | `models/props.glb` + the trim atlas `tex/kit_*.webp` from Quaternius's CC0 Medieval Village and Fantasy Props MegaKits (doors, windows, rails, barrels, crates, wagon...), the re-UV'd revolver and the dynamite bundle  | the unzipped kits, `tools/art/props-src.glb`                                   |
| `make-luts.ts`        | Export the in-game time-of-day grades (`engine/lut.ts`) as 32³ `.cube` files for a colourist                                                                                                                             | none                                                                           |
| `ui-audit.ts`         | UI layout audit of every game screen at twelve sizes in real Chrome: text overflow, clipping, ellipses on short text, overlapping text, tap targets, game fonts on controls, dead primary buttons. See below             | a dev server, a local API, Playwright                                          |
| `float-audit.ts`      | Floating-object audit of both scenes (duel street, Frontier) at both tiers in real Chrome: floaters, kit pieces off their wall, props sunk into a deck, z-fighting faces; `--shots=dir` saves low-angle views. See below | a dev server, Playwright                                                       |
| `art/`                | Source art for generated textures (e.g. `signboard_src.webp`, Gemini)                                                                                                                                                    |                                                                                |
| `audio/`              | The soundtrack: `manifest.ts` (every ElevenLabs prompt), `generate.ts`, `recipes.ts` + `build.ts` (master to −16/−18 LUFS, ≤ −1 dBTP, loop points), `loudness.ts` (report), `verify-duel.ts` (in-browser meters)         | `ffmpeg` (with `aac_at`), Apparish generators, Playwright for `verify-duel.ts` |
| `PERF.md`             | How to measure, the numbers so far, and the real-device checklist                                                                                                                                                        |                                                                                |

## Recipes

```bash
# A generic material: always prefer Poly Haven scans
bun tools/polyhaven.ts weathered_plank_siding public/experiments/out-west/3d/tex --maps diff,nor_gl,arm --name planks

# A bespoke material: Gemini albedo -> PBR (run the generator from the Apparish repo, see the
# asset-tools note; prompt for "flat, evenly lit, shadowless, seamless albedo", check the 2x2 tiling)
bun tools/pbr-from-albedo.ts tools/art/signboard_src.webp public/experiments/out-west/3d/tex/signboard \
  --size 512 --strength 3 --rough 0.6,0.9 --radius 16 --q 80

# A GLB for the web (hero: --tex 2048 --ktx uastc; props: --ktx etc1s; FFA: --tex 512) + a 25% LOD
bun tools/optimize-gltf.ts in.glb public/experiments/out-west/3d/models/out.glb --tex 1024 --lod 0.25

# LUTs for grading in Resolve: load the .cube, grade over an in-game capture, export a 32³ .cube,
# then load it at runtime with lutFromCube() (engine/lut.ts)
bun tools/make-luts.ts /tmp/ow-luts
```

KTX2: `optimize-gltf.ts` writes KTX2/Basis only when KTX-Software's `toktx` is on PATH
(`brew install ktx`). Shipping KTX2 also needs `KTX2Loader` and the Basis transcoder (copy
`three/examples/jsm/libs/basis/*` into `public/experiments/out-west/basis/`) registered on the
GLTFLoader in `engine/assets.ts`. Until then, WebP inside GLB (what the current models use) is the
format.

## Characters and props (no Blender)

```bash
# Packs: download the free [Standard] zips from quaternius.com (itch.io), unzip, and flatten into
#   <src>/base  <src>/outfits  <src>/hair  <src>/ual  <src>/swatch (Poly Haven sets, see below)
for id in brown_leather caban scuba_suede rough_linen hessian_230; do
  bun tools/polyhaven.ts $id <src>/swatch --name $id
done
bun tools/build-characters.ts <src>          # models/{player,casual,...}.glb + tex/char_*.webp
bun tools/build-props.ts <kit_dir>           # models/props.glb + tex/kit_*.webp
```

- Every base shares one skeleton (renamed to the game's rig names) and one 2048x3072 atlas; the
  player GLB carries the clips. Garment material names (Shirt, Sleeves, Pants, Boots, Belt,
  Bracer, Pauldron, Hair, Skin) are the outlaw tint keys; a tint recolours only the garment's main
  fabric (mask in `char_arm.r`).
- Kit pieces keep their trim-sheet UVs (U tiles), stacked into one atlas band per sheet; they all
  draw with the one "Kit" material bound in `engine/assets.ts`.

KTX2: Homebrew has no `ktx` formula. The KTX-Software 4.4.2 macOS pkg can be unpacked without
installing (`pkgutil --expand-full`, then run `ktx` with `DYLD_LIBRARY_PATH` at its `lib/`), but
shipping KTX2 also needs the Basis transcoder (`basis_transcoder.js`) served to the page, which
the repo's zero-JS rule rules out as a committed file. The atlases ship as WebP.

## Float audit

```bash
bun run dev --port 4365                        # another shell
bun tools/float-audit.ts                       # both scenes x both tiers; exit 1 on any floater
bun tools/float-audit.ts --scene=frontier --tier=low --shots=.playwright-mcp/float
```

It hooks the scene through `__THREE_DEVTOOLS__` (no game code involved) and imports
`src/experiments/out-west/scene/float-audit.ts` into the page. Every static piece (an instance, a
kit piece inside a merged mesh via `userData.pieces`, or a connected component of a GeoBuilder mesh)
is checked for air under its foot (> 3 cm), contact with anything (wall-mounted kit > 2 cm off its
wall), a foot buried under a deck, and coplanar same-facing overlaps. Lanterns, pickups and money
bags hang by design and are listed with their mount distance. Every scene and tier passes with zero
failures (the clock tower replacement fixed the last ones). The duel street's dressing is placed at
random, so rerun before chasing a one-off barrel/crate z-fight.

## UI audit

```bash
PUBLIC_API_URL=http://localhost:8811 bun run dev --port 4371      # another shell
bunx wrangler dev --config api/wrangler.jsonc --local --port 8811 --infer-origin-from-routes=false
bun tools/ui-audit.ts                          # every screen x every size; exit 1 on any finding
bun tools/ui-audit.ts --size=375x812 --screen=store --shots=after   # one size, matching screens, PNGs
bun tools/ui-audit.ts --guest                  # signed-out screens and fixtures only (no account)
```

Sizes: 375x812 and 812x375 (touch, DPR 3), 390x844, 360x740 (touch), 1440x900 (mouse), the
iPhone Duo foldable (outer 466x678, outer in Safari 382x580, inner 951x669 and 669x951, iPhone UA)
and iPad (mini 744x1133, 13-inch 1376x1032, one-third Split View 320x1032, iPad UA), so
`platform/device.ts` scales them as on the device. Screens are
reached by playing where that's quick (title, credits, the hub and every hub sheet, the Outfitter's
tabs and a dye job, both leaderboard tabs, account and delete, profile, report, the queue, the
licence gate, notices, prestige, the closed town, the Frontier practice HUD and pause). The rest are
mounted from `ui-audit/fixtures.ts` with worst-case data, through the game's own UI classes: the duel
HUD, the call, the card, pause, the gauntlet ledger, the match intro, every results state (win,
loss, froze, draw, coward, forfeit, dodge, ghost, room closed, opponent left, line dead, pending)
and the Frontier death card, riders list and an everything-on HUD. Names are 16 wide capitals, the
server's maximum.

Signed-in state is set up directly, not played: a passkey account on a CDP virtual authenticator,
then SQL on the local D1 (level 12 and unlicensed, then level 50, $1,234,567, licensed, the whole
catalog), with an away report and a closed town injected into `/me` and `/town/lobbies`. Each run
registers one account (the API allows 10 an hour per client). `.dev.vars` needs
`RP_ORIGINS`/`ALLOWED_ORIGINS` set to the dev server's origin.

`ui-audit/probe.ts` runs in the page. Per screen it reports: text outside its own box (measured with a
Range, so leftward overflow counts too), text clipped by an ancestor or the screen edge, text faded
by a scroll strip's edge mask, truncated short text (ellipsis or line clamp), overlapping lines of
text, a heading row whose button wrapped under it, tap targets under 44 px (24 px with a mouse),
controls whose font-family doesn't start with Ultra, Rye, EB Garamond or Oswald, and a disabled
primary button on a results receipt. A step it can't reach (a control off screen) is a finding too.
The Frontier kill feed and the dev toolbar are skipped.

## Runtime pieces that replace offline bakes (while Blender is unavailable)

- **Light probe / IBL:** `engine/probe.ts` captures a 128² cube of the lit street from the duel spot
  (two faces per frame, never a hitch), prefilters it with PMREM, and sets `scene.environment`. It
  recaptures when the time of day moves (World bumps `scene.userData.owLightVersion`). This stands in
  for `tools/bake-probes` (offline SH probes from a lightmapped town).
- **Town AO:** `scene/town-pbr.ts` darkens indirect light under porch roofs, at wall feet and toward
  the boardwalks. It stands in for the Cycles AO/indirect lightmap (§10.4).
- **LODs:** `scene/lod.ts` simplifies baked characters at runtime (meshopt, in a worker).
  `tools/optimize-gltf.ts --lod` does the same offline for static GLBs.

## What the Blender MCP would add (not connected in this session)

- `tools/blender/build_town.py`: build the street from `town.layout.json`, generate lightmap UV2,
  and bake Cycles indirect + AO + sun visibility (shadowmask) per time of day into RGBM KTX2
  lightmaps. This would replace the procedural town AO and give real bounce light and soft contact
  shadows.
- `tools/bake-probes/`: L2 SH probe grid from the lightmapped town, for characters (cheaper than
  PMREM sampling).
- Characters: bespoke sculpted faces/hands, a proper western outfit set (the free packs have a
  peasant and a ranger outfit, recoloured per outlaw), cloth-fitted coats and ponchos (ours are
  procedural shells fitted at runtime), and hand-made LOD0-2 instead of meshopt simplification.
- Proper LOD0–2 via Decimate with hand fixes, and VAT bakes from the clean LOD2.
