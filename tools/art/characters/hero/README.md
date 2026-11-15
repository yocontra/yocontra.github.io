# Anatomical hero reference

This is an isolated authoring candidate. It does not replace the production
catalog and is not accepted as finished hero art.

The CC0 MakeHuman/MPFB graphic base, three macro shapes, game rig landmarks and
weights are pinned to `9de0707fdc88438d7c53a1a2ac7937d9221e2431`. The selected
middle-aged male diffuse skin is by jartur69, published as CC0 in the MakeHuman
`skins02` pack. Only that skin was extracted from the pack. `cc0/provenance.json`
records exact URLs, archive entries, byte counts, hashes and licenses. The pack's
original metadata and upstream license text are retained. No addon program code
is included. See the [MakeHuman asset license](https://static.makehumancommunity.org/about/license.html).

`hero-reference.blend` keeps the fitted topology, UVs, editable native joint
groups, eye construction and reference lights. It links the preserved skin image
by a relative path. `hero-skin-reference.glb` carries portable `_AUTHOR_JOINTS`
and `_AUTHOR_WEIGHTS` in the player's original 50-joint order. The separate eye
GLB is bound to the existing Head joint by the preview baker. The baker retains
every original animation channel, inverse bind matrix, weapon socket and wardrobe
position, and explicitly selects the lossless high texture profile. Masters stay
unchanged.

Rebuild from the repository root:

```sh
blender --background --factory-startup --python tools/content/hero-foundation-authoring.py
KTX_ENCODER=/path/to/toktx bun tools/content/hero-reference.ts
OUT_WEST_URL=http://127.0.0.1:4397 bun tools/test-playcanvas-hero-reference.ts
```

The native preview is written to
`public/experiments/out-west/3d/native-v2/reference/baked/player.glb`; this
unregistered derivative is intentionally not a production source. It can be
regenerated whenever needed. The capture tool uses the actual mounted duel page
and checks live native skin binding across ten clips. It writes twenty body and
portrait captures plus a receipt under `/tmp/out-west-hero-native`.

Native review exposed and corrected a Blender/OBJ versus glTF vertical UV-origin
mismatch and an anatomical wrist-frame mismatch. Passing joint/animation checks
does not accept the rendered character. The current visual defect list is:

- Seat and refit the existing hat against the new skull; improve its material.
- Refine eye alignment, iris normals, eyelid contact and tear-line geometry.
- Replace the old pointed collar and blend the neck into a fitted shirt.
- Rebuild faceted clothing construction and qualify PBR surface detail.
- Qualify fingers against each weapon grip, firing motion and paired pose.
- Author hair/brows and dedicated skin roughness/normal maps.
- Produce and measure mobile geometry/texture tiers after the hero is accepted.

The 2K diffuse image is a reference material, not a complete scanned PBR skin.
The current body/portrait captures establish integration evidence, not AAA art
acceptance or coverage of every outfit identity.
