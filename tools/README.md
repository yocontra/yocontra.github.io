# Out West content tools

The runtime uses PlayCanvas containers, native animation, PBR materials and authored equipment.
No browser geometry builder is part of the content pipeline. Editable authoring sources live in
`tools/art/characters` and `tools/art/environments`; their READMEs describe the reproducible bakes.
Edit these in a glTF authoring program or import an authored replacement; preserve the standardized
skeleton and clip names. Current outputs live in `public/experiments/out-west/3d/native-v2`.
Keep the prior public GLBs unchanged: already open v1 clients still use those URLs.
Third-party sources and licences are recorded in `3d/CREDITS.md`.

Start with `bun install --frozen-lockfile`. Asset baking also requires the official
[Khronos KTX-Software 4.4.2 tools](https://github.com/KhronosGroup/KTX-Software/releases/tag/v4.4.2).
Use that release's `toktx` executable; set `KTX_ENCODER` to its installed path and verify its
version before baking. All source assets are checked in; no baseline checkout or temporary
capture directory is required.

```sh
export KTX_ENCODER=/path/to/KTX-Software-4.4.2/bin/toktx
"$KTX_ENCODER" --version
bun tools/content/character-materials.ts
bun tools/content/character-clips.ts
bun tools/content/character-textures.ts
bun tools/content/environment.ts
bun tools/content/manifest.ts
bunx biome format --write src/experiments/out-west/content
bun test tests/content-playcanvas tests/duel-playcanvas
bun tools/preview-playcanvas-content.ts http://localhost:4389
bun tools/test-playcanvas-duel.ts http://localhost:4389
bun tools/item-thumbs.ts http://localhost:4389
bun tools/check-item-thumbs.ts
```

The offline tools decode source files, preserve authored PBR detail, deduplicate, weld and
quantize geometry. Native KTX2 textures use full-resolution UASTC through Khronos toktx 4.4.2.
Their output uses glTF extensions supported by the pinned PlayCanvas parser. `manifest.ts`
publishes byte counts, SHA-256 hashes, revisioned URLs and a combined content version.
Both clients and authoritative rooms check the collision revision.

`content/collision.json` contains simplified static boxes and triangle surfaces for the complete
town, including door and window openings, floors, roofs, steps and shaped cover. Physics imports
this artifact directly. After editing it, set its version to the SHA-256 of
`JSON.stringify({boxes, meshes})` and regenerate the manifest.

Equipment loads lazily per catalogue item. Outfits carry one standardized animated skeleton.
Skinned holsters/extras bind to that skeleton; hats, spurs and guns use named bone mounts.
Paired guns carry separate left/right drawn and holstered mounts. Explicit native PBR metadata
preserves skin, metal and authored dye variants through shared native texture leases.
The CC0 HDRs in `3d/env` supply the native environment atlas and image-based lighting.

The thumbnail build uses PlayCanvas and the same equipment GLBs and environment as the game.
It rebuilds every visible catalogue item and hashes all source assets and studio code. The
freshness check rejects missing, replaced or stale cards. Browser previews and the real-page
Duel lifecycle test save screenshots under `/tmp`.

Other retained offline utilities cover source animation import (`build-moves.ts`), CC0 material
fetching (`polyhaven.ts`), texture processing (`pbr-from-albedo.ts`, `seamless.ts`), title art,
fonts, audio mastering, browser UI checks and performance measurements. `building-audit.ts`
checks the shared town layout rules without a browser. `PERF.md` describes the requested simulator
acceptance surface and the remaining iPhone performance target; host GPU measurements do not
establish A15 performance.
