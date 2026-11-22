# Authored environment sources

These GLBs preserve the complete environment art recovered from Out West revision
`6c5f9f3`: the street and three campaign arenas, and Perdition's buildings, interiors,
cover, outskirts and all 793 placed desert plants across eleven species. They are
authoring inputs, never browser imports. Material images are embedded after their
source PBR maps finish loading. Terrain walls have ordinary side-projected UVs;
foliage wind is an authored glTF morph animation, played by native PlayCanvas Anim.

The recovery used that revision's scene builders and texture sources in an isolated
offline export. The Three renderer and procedural scene builders are not runtime
dependencies of the rewritten game. This preserves the original artwork while keeping
the shipped game on the native engine.

Edit these files with a glTF authoring tool. Run `bun tools/content/environment.ts`
to regenerate the supported native GLBs, and `bun tools/content/manifest.ts` after all
character and environment outputs are ready. The environment builder flattens the
old masonry atlas into ordinary native PBR materials and repeating UVs. It checks
that Perdition retains its vegetation. `lighting.json` retains the original campaign
daylight, dusk and night art direction as sampled authored parameters.

`textures/` holds CC0 Poly Haven scans (diffuse, OpenGL normal, AO/roughness/metal) used
by Perdition's authored surfaces; each keeps its Poly Haven asset id as the file prefix.
`saguaro_skin`, `prickly_pear` and `sagebrush` are tileable Blender bakes in the same
layout. `frontier-cacti.glb` holds the Blender-authored saguaros (near and far
variants) and prickly pear, tinted by vertex colour over those maps. Hay bales use the
`thatch_roof_angled` scan as baled straw.

The supported output is `/3d/native-v2/baked/`; prior public GLBs remain compatible
with already open v1 tabs. Environment maps use native `KHR_texture_basisu` with
UASTC KTX2, preserving the optimized image dimensions. The builder shares the
character pipeline's pinned Khronos `toktx` 4.4.2 encoder:

```sh
KTX_ENCODER=/path/to/toktx bun tools/content/environment.ts
bun tools/content/manifest.ts
```

`street-lamp.glb` is authored by `tools/content/street-lamp-authoring.py` in Blender 4.5; the
bank build swaps its gallows lanterns and step-lamp heads for it. Frontier authoring reuses its
lantern body, glass and carrying bail with the town’s fitted wall brackets.

`clockwork.glb` contains nine authored joints in two native skinned meshes, with
campaign hour poses, the boss's 11:59 pose, and a damped bell-swing clip. Those
moving faces are absent from the static street source. The wanted-paper default
image preserves its UVs through optimization; the runtime paints the current
outlaw onto a native texture. The cloud mask and street-detail map retain the
original cloud shade, wagon ruts and hoofprint definition through ordinary native
material channels. No recovered shader executes in the shipped game.

For repeatable visual and GPU-retention captures of all17 acts in one application:

```sh
bun tools/test-playcanvas-environments.ts http://127.0.0.1:4390
```

This dev-source harness records the native environment and clock separately from
riders, captures each act, checks actual clock-joint animation and disposal, and
rejects retained arena texture growth. It does not certify physical-device FPS.

Dusk and night skies retain the original small star cells in 4096×2048 RGBE
captures with lossless Radiance scanline encoding. The authored images account for
native cubemap handedness so clouds and the sun retain their world direction.
Their visible native cubemaps
use 1024px faces; daytime faces remain 256px. Lighting convolution stays at 128px
with a 256px atlas. Source HDR textures are released after convolution, and only
the current sky and lighting outputs remain allocated.

## Perdition saloon

`frontier-saloon.glb` contains the open back bar, bottles, stoneware and two
hanging lamps in town coordinates. Regenerate it before running the regular
Frontier author and environment bake. The bar reuses the town's floorboard
maps. The native room lights use the street-facing windows and the two named
lamp origins. The cover volumes and floor height come from the Frontier plan.

```sh
blender --background --factory-startup --python tools/content/frontier-saloon-authoring.py
```

The turned-leg card table, oak worktable and potbelly stove live in
`frontier-furniture.glb`. Authoring fits them to the existing table and stove
cover sites and shares the town's timber, iron and cloth maps.

```sh
blender --background --factory-startup --python tools/content/frontier-furniture-authoring.py -- tools/art/environments/frontier-furniture.glb
```

## Articulated crow wings

The ambient crow uses three joints per wing and a corrective shape for the fold.
Curved coverts replace the plates, and a tapered layer under the feathers closes the
wrist seam during the fold. The model keeps its native plumage maps and two-second
Idle, Fly and Gun_Shoot clips. The campaign's separate crow cue still runs for three
seconds.

```sh
bun tools/content/animal-prop-authoring.ts crow
bun tools/content/manifest.ts
OUT_WEST_URL=http://127.0.0.1:4389 bun tools/test-playcanvas-crow-fold.ts
```

Run the authoring command with Blender and the pinned KTX encoder on PATH.
`bun tools/content/crow-fold.ts /tmp/crow.glb` also rebuilds the fold from the
frozen native input `crow-articulated-base.glb`. Set `OUT_WEST_CROW=/tmp/crow.glb`
to review the staged file in headless Chrome.

## Quick Draw surface finishes

Use staging directories to preserve the fitted props and native geometry in the
released arenas. The texture overlay checks that the scene graph, mesh positions,
faces and unowned texture data match its input after the write.

1. Export `duel.glb`, `depot.glb`, `mission.glb` and `bank.glb` from the native
   asset directory at revision `6f90a19d` into a baseline directory.
2. Run `bun tools/content/environment.ts --only duel --output "$regular"` and
   repeat for `depot`. Use the pinned KTX encoder.
3. Copy the Mission and Bank authoring GLBs into the stone staging directory as
   `mission-input.glb` and `bank-input.glb`. Run:

   ```sh
   bun tools/content/flatten-civic.ts "$stone/mission-input.glb" "$stone/bank-input.glb"
   KTX_ENCODER=/path/to/toktx bun tools/content/arena-stone-materials.ts "$stone"
   bun tools/content/arena-finish-overlay.ts "$baseline" "$regular" "$stone" "$staged"
   ```

4. Verify the staged maps in the native arena test above and regenerate the
   asset manifest after copying the accepted GLBs into the native asset directory.
