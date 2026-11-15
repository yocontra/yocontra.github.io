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

For an isolated candidate bake, pass an output directory outside the published tree:

```sh
KTX_ENCODER=/path/to/toktx bun tools/content/environment.ts --only frontier --source /path/to/source --output /path/to/stage/baked
```

The staged GLB embeds its maps; intermediate KTX2 files stay under that output's
`resources/` directory. Staging does not publish ambient assets or shared metadata.
`compressEnvironmentTextures` also honours an existing `withContentOutput` scope.

`street-lamp.glb` is authored by `tools/content/street-lamp-authoring.py` in Blender 4.5; the
bank build swaps its gallows lanterns and step-lamp heads for it.

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

## Crow fold authoring candidate

`crow-articulated-base.glb` freezes the current native bird as an offline input,
including its existing external texture URLs. `crow-fold-authoring.py` runs in
headless Blender, replaces the rectangular wing plates with layered coverts, adds
shoulder/elbow/wrist skinning, and bakes a corrective shape to close the feather fan.
The native two-second Idle/Fly/Gun_Shoot clips remain separate from the campaign
crow cue's three-second Gun_Shoot contract. Historical public GLBs are unchanged.

```sh
blender --background --factory-startup --python tools/content/crow-fold-authoring.py
OW_ORIGIN=http://127.0.0.1:4389 bun tools/test-playcanvas-crow-fold.ts
```

The output defaults to `/tmp/out-west-crow-fold/crow.glb`; the browser probe is
headless and route-fulfills that candidate without overwriting production content.
Its poses, native skin bindings, fold transitions and corrective endpoints need
review before promotion. Earlier candidates were rejected for stretched plates,
open feather fans and atlas sampling outside the intended feather island. The
latest leading-edge overlap and transition captures remain pending. This is not
AAA art acceptance: body plumage, flight shape and complete scene coverage still
need review. No reference photographs are embedded in the asset.
