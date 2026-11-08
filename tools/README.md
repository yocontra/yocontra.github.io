# Out West content tools

The runtime uses PlayCanvas containers, native animation, PBR materials and authored equipment.
No browser geometry builder is part of the content pipeline. Canonical GLBs live in
`public/experiments/out-west/3d/baked`, `equipment` and `dynamic`. Edit these in a glTF authoring
program or import an authored replacement; preserve the standardized skeleton and clip names.
Third-party sources and licences are recorded in `3d/CREDITS.md`.

```sh
bun tools/content/optimize.ts public/experiments/out-west/3d/equipment/hat.sombrero.glb
bun tools/content/manifest.ts
bunx biome format --write src/experiments/out-west/content
bun test tests/content-playcanvas tests/duel-playcanvas
bun tools/preview-playcanvas-content.ts http://localhost:4389
bun tools/test-playcanvas-duel.ts http://localhost:4389
bun tools/item-thumbs.ts http://localhost:4389
bun tools/check-item-thumbs.ts
```

The optimizer decodes old meshopt files, removes unused attributes, deduplicates, welds,
quantizes and embeds WebP textures. Its output uses the glTF extensions supported by the pinned
PlayCanvas parser. `manifest.ts` publishes byte counts, SHA-256 hashes, revisioned URLs and a
combined content version. Both clients and authoritative rooms check the collision revision.

`content/collision.json` contains simplified static boxes and triangle surfaces for the complete
town, including door and window openings, floors, roofs, steps and shaped cover. Physics imports
this artifact directly. After editing it, set its version to the SHA-256 of
`JSON.stringify({boxes, meshes})` and regenerate the manifest.

Equipment loads lazily per catalogue item. Outfits carry one standardized animated skeleton.
Skinned holsters/extras bind to that skeleton; hats, spurs and guns use named bone mounts.
Paired guns carry separate left/right drawn and holstered mounts. `Character` materials preserve
skin and metal; `Dyeable` materials allow native per-player cloth/leather colour instances.
The CC0 HDR in `3d/env` supplies the native environment atlas and image-based lighting.

The thumbnail build uses PlayCanvas and the same equipment GLBs and environment as the game.
It rebuilds every visible catalogue item and hashes all source assets and studio code. The
freshness check rejects missing, replaced or stale cards. Browser previews and the real-page
Duel lifecycle test save screenshots under `/tmp`.

Other retained offline utilities cover source animation import (`build-moves.ts`), CC0 material
fetching (`polyhaven.ts`), texture processing (`pbr-from-albedo.ts`, `seamless.ts`), title art,
fonts, audio mastering, browser UI checks and performance measurements. `building-audit.ts`
checks the shared town layout rules without a browser. `PERF.md` describes the device evidence
required for the iPhone performance target; desktop browser checks do not establish that target.
