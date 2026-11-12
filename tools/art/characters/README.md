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
KTX_ENCODER=/path/to/KTX-Software-4.4.2/bin/toktx bun tools/content/human-assets.ts
bun tools/content/character-clips.ts
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
mesh modifiers, preserves UV seams, and bounds each garment to about 1,800 triangles including buttons and welt pockets.
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

The continuous coat sleeves are portable native-skin geometry in `coat-sleeves/`.
`boot-bridges/` replaces every `RidingBoot` range with one canonical 1880s riding
boot from `tools/content/cowboy-boot-model.py` (13 in scalloped shaft with pull
loops, welted sole, underslung 1.7 in heel), placed from each body's ankle, knee
and foot joints, and refits the trouser legs to fall over and tuck inside the rim.
The same run paints the shared `textures/cowboy-boot.*` leather maps (chocolate,
black and russet albedo plus one normal and one occlusion/roughness map); these
bake to a separate `Boots` material shared by every actor. Rebuild with Blender:

```
blender --background --factory-startup --python tools/content/coat-sleeves-authoring.py
blender --background --factory-startup --python tools/content/boot-bridges-authoring.py
blender --background --factory-startup --python tools/content/paired-poses-authoring.py
blender --background --factory-startup --python tools/content/seated-poses-authoring.py -- outlaw-2 outlaw-6
```

Coat/boot source fingerprints and exact joint order, plus portable pose input
fingerprints, are validated before those artifacts are merged. Paired corrections affect only the left upper/lower arm and
wrist rotations where the original hands crossed; right-side motion, fingers,
clip durations and natural flinch motion remain authored. Seated clips carry the
measured per-body hip-to-seat offset; furniture and floor heights must match their
contact frame. The final native skin normalization always runs after export.

Gun styles keep their authored albedo UVs and part-specific metallic factors.
A padded UV1 atlas adds spatial roughness/wear and one shared fine normal map;
all gun styles still combine into the same rigid material draw. Prop palettes
retain their original conversion path.
