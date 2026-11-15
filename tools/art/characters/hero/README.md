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
groups, eye/brow construction, fitted felt hat, turned collar, shirt body/yoke, full sleeves,
doubled cuffs and reference lights. It links the preserved skin image
by a relative path. `hero-skin-reference.glb` carries portable `_AUTHOR_JOINTS`
and `_AUTHOR_WEIGHTS` in the player's original 50-joint order. The separate eye
GLB is bound to the existing Head joint by the preview baker. The baker retains
every original animation channel, inverse bind matrix and weapon socket. New
garments replace the corresponding original pieces; the hat retains its detachable
Head mount. The baker explicitly selects the lossless high texture profile. Masters stay
unchanged.

Rebuild from the repository root:

```sh
blender --background --factory-startup --python tools/content/hero-foundation-authoring.py
KTX_ENCODER=/path/to/toktx bun tools/content/hero-reference.ts
OUT_WEST_URL=http://127.0.0.1:4397 bun tools/test-playcanvas-hero-reference.ts
```

The native preview and generated textures are staged under
`/tmp/out-west-hero-content` (override with `OUT_WEST_HERO_CONTENT`). The capture
tool fulfills only matching requests from that directory, without copying reference
content into the public application. It uses the actual mounted duel page and
checks live native skin binding across twelve clips. It writes thirty-six body,
portrait and weapon-hand captures plus a receipt under `/tmp/out-west-hero-native`.
An async-local output scope keeps concurrent offline bakes in separate destinations.

The original cotton twill is authored as a physical 8 mm repeat with separate
512-square color, tangent-normal and occlusion/roughness/metalness maps. Garment
UVs preserve this density. Sleeve ease, seam allowances, turned cuffs and collar
thickness are geometry; the weave is surface detail. These remain reference
assets until animation and close-up review pass.

Native review exposed and corrected a Blender/OBJ versus glTF vertical UV-origin
mismatch and an anatomical wrist-frame mismatch. Passing joint/animation checks
does not accept the rendered character. The current visual defect list is:

- Complete native acceptance of the newly seated hat, eyes, brows and neck/collar blend;
  iris/sclera intersections are corrected, but eyelids and groom still need refinement.
- Refine eyelid contact, tear-line geometry and facial animation.
- Rebuild the floating vest straps, trousers and boots. The new shirt closes the
  shoulder openings, but its sleeves still read too smooth/inflated and need
  realistic compression folds and contact with the underlying arm.
- Correct baseline finger penetration and floating contact against each weapon grip,
  firing motion and paired pose; production screenshots reproduce these defects.
- Author hair and dedicated skin roughness/normal maps.
- Produce and measure mobile geometry/texture tiers after the hero is accepted.

The 2K diffuse image is a reference material, not a complete scanned PBR skin.
The current body/portrait captures establish integration evidence, not AAA art
acceptance or coverage of every outfit identity.
