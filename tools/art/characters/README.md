# Fitted character authoring sources

These glTF files preserve the original Out West `6c5f9f3` fitted rigs and meshes before
native engine optimization, including source texture texels, garment boundaries,
per-vertex tint, fabric luminance, roughness/skin metadata, and gun PBR attributes.
Shared lossless WebP textures are deduplicated by content. The characters retain the
licenses and provenance in public/experiments/out-west/3d/CREDITS.md.

The one-time recovery used the original `dressedActor`, `castActor`, `FolkPose`,
`DrawLayer`, long-gun fitter, and dressed animal authoring graph. Their procedural
poses were sampled at 30 Hz into ordinary skeletal animations. Those modules are
not a runtime dependency. The native build is reproducible from this preserved
source, without the previous renderer or shader implementations:

```
bun tools/content/character-materials.ts
bun tools/content/character-clips.ts
KTX_ENCODER=/path/to/KTX-Software-4.4.2/bin/toktx bun tools/content/character-textures.ts
```

`character-materials.ts` evaluates the original masked recolor operation in linear
light into cropped PBR albedos, retains source texel density, bakes fabric roughness,
and emits lazy finite dye albedos. Skin, hair, eyes and uncolored details share the
original full atlas. The ARM red channel remains a recolor mask and is never used
as ambient occlusion. Runtime materials use PlayCanvas StandardMaterial and shared
engine Texture assets. The source `.gltf`/`.bin`/texture files are build inputs and
must not be served by the game.

The final texture step uses full-resolution UASTC quality 2, generated mipmaps and
Zstandard level 6. Albedo is encoded as sRGB; normals and ARM palettes remain linear.
PlayCanvas uses its native Basis transcoder. `texture-encoding.json` records the
source-image mapping and encoder options. Individualized outlaw habits are preserved
in `stances/`; paired outfit and holster source variants preserve both hip cutouts.

The shared native moves build also emits finite crouched weapon poses. The offline
`crouch-character-clips.ts` helper compensates the authored crouch hip rotation at
Abdomen, keeping the same upper-body world frame while the native lower controller
continues the crouch gait. It never modifies shared runtime tracks. Long-gun hold
and recoil sources contain the fitted support-hand curl, sampled from the original
bind-pose mirror correction and expressed relative to the actual support wrist.
Frontier draws the right revolver and keeps a paired loadout's spare left revolver
in its holster; the two-gun action clips remain specific to Duel.

Nine waistcoat sources identify the obsolete apron pieces with `waistcoatFit`
metadata. Their replacement garments are authored by Blender from the actual
shirt tailoring surface, including a V neckline, continuous shoulders, armholes,
and folded edges. Blender transfers the original joint weights through its native
mesh modifiers, preserves UV seams, and bounds each garment to about 2,200 triangles including buttons and welt pockets.
The portable authoring GLBs in `waistcoats/` store those skin IDs and the original
wool UV swatch. The native baker copies that geometry and removes shirt details
covered by the new cloth. No garment fitting or cloth solver runs in the game.

To regenerate these editable garment sources with Blender on PATH:

```
bun tools/content/waistcoat-authoring.ts
```

Every character command accepts `OUT_WEST_CHARACTERS` as a comma-separated list of
source IDs. This also scopes texture promotion, so human and animal authoring can
run without rewriting one another's containers. For example:

```
OUT_WEST_CHARACTERS=outfit.shirt-vest bun tools/content/character-materials.ts
OUT_WEST_CHARACTERS=outfit.shirt-vest bun tools/content/character-textures.ts
```

The texture promotion step rewrites only containers whose material URLs change.
Already compressed containers retain their exact bytes, and encoding provenance is
merged with the existing source-image record rather than replacing earlier entries.

The four spurs share three small Blender-authored worn-metal source maps. Rebuild
them with `blender --background --factory-startup --python tools/content/metal-authoring.py`.
Their native materials retain each variant's iron, silver, brass or blued finish,
with linear roughness/metalness and fine surface normals compressed to shared KTX2.
Linen and worn leather receive semantic roughness adjustment during the atlas bake;
the replacement waistcoat attenuates the old apron normal map's exaggerated folds.
