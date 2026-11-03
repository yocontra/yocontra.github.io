# out west asset pipeline (`tools/`)

Bun + TypeScript, typechecked by `tsc -p tools` (part of `bun run check`). Owned by stream H;
reuse freely. Every third-party or generated asset gets a line in
`public/experiments/out-west/3d/CREDITS.md`.

| Tool                 | What it does                                                                                                                                                                                                     | Needs                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `polyhaven.ts`       | Fetch a Poly Haven CC0 PBR set (diffuse, GL normal, ARM, …) and write WebP maps                                                                                                                                  | `cwebp`                                                                        |
| `pbr-from-albedo.ts` | Derive normal + ARM (AO, roughness) from a flat albedo (design doc §10.2): Gemini signage, posters, leather                                                                                                      | `ffmpeg`, `cwebp`                                                              |
| `optimize-gltf.ts`   | dedup → prune → weld → resize → KTX2 (or WebP) → quantize → meshopt, plus an optional simplified LOD file                                                                                                        | `bunx` (fetches `@gltf-transform/cli`), optional `toktx`                       |
| `make-luts.ts`       | Export the in-game time-of-day grades (`engine/lut.ts`) as 32³ `.cube` files for a colourist                                                                                                                     | none                                                                           |
| `art/`               | Source art for generated textures (e.g. `signboard_src.webp`, Gemini)                                                                                                                                            |                                                                                |
| `audio/`             | The soundtrack: `manifest.ts` (every ElevenLabs prompt), `generate.ts`, `recipes.ts` + `build.ts` (master to −16/−18 LUFS, ≤ −1 dBTP, loop points), `loudness.ts` (report), `verify-duel.ts` (in-browser meters) | `ffmpeg` (with `aac_at`), Apparish generators, Playwright for `verify-duel.ts` |
| `PERF.md`            | How to measure, the numbers so far, and the real-device checklist                                                                                                                                                |                                                                                |

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
- Characters: UV-unwrap the CC0 bases and bake 1K PBR (albedo, normal, ORM) from a sculpted or
  generated high-poly, or source or generate higher-fidelity rigged characters (Sketchfab
  CC0/CC-BY, Hyper3D Rodin, Hunyuan3D) and retarget them onto the shared Quaternius skeleton, so
  `actor.ts` and `fit.ts` keep working. The current bases are low-poly, flat-shaded and have no
  UVs, which caps character quality at "clean stylized".
- Proper LOD0–2 via Decimate with hand fixes, and VAT bakes from the clean LOD2.
