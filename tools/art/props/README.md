# Western props and animals

The source Kit comes from the existing read-only `public/experiments/out-west/3d/models/props.glb`.
Its named chest, pouch, sack and dynamite meshes replace the former geometric placeholders.
The chest keeps its lid, lock and ironwork. Each imported prop uses uniform scaling and a floor-aligned,
centered pivot inside its former gameplay bounds. Existing public GLBs remain unchanged for open tabs.

`tools/content/animal-prop-authoring.ts` reproduces the native outputs:

```sh
KTX_ENCODER=/path/to/toktx bun tools/content/animal-prop-authoring.ts
```

Use `props` or `animals` as the final argument for a selective bake. The animal pass preserves
the dog and horse skeletons, named clips and source transforms. It adds directional coat maps to
their existing color regions. Crow and hen detail follows their original animated mesh nodes;
clock joints, wind and cue tracks stay authored native animations. The coin retains its original
motion and receives a stamped face. `animal-prop-surfaces.ts` authors tileable surface maps without
replacing the original material colors. Animal images have their own `characters/animal-textures`
folder, separate from human garments.

All new runtime props use `native-v2/dynamic`; birds, clockwork and wilds use `native-v2/ambient`.
The legacy group crow cue has its own `native-v2/dynamic/crow.glb`: its three-second
`Gun_Shoot` motion must not alias the ambient crow’s two-second flight.

Albedo, normal and ARM maps are full-resolution UASTC KTX2 with mipmaps and immutable shared URLs.
Different prop containers lease the same Kit maps instead of embedding another full atlas in each
container. Native skin-node normalization is the last animal export stage. `nativePbr.ao` explicitly
marks genuine ARM-red occlusion; the old human ARM-red recolor mask must never opt in.

`nonfrontier-ambiance.ts` dresses the four campaign source scenes with a bounded set of service
props and painted shop identities, and adds cactus, bark, straw and iron surface definition. It
preserves the central duel lane, existing actor anchors, animations and all restored vegetation.
Run it once, then bake the selected scenes without reducing their authored image dimensions:

```sh
KTX_ENCODER=/path/to/toktx bun tools/content/nonfrontier-ambiance.ts
for arena in duel depot mission bank; do
  KTX_ENCODER=/path/to/toktx bun tools/content/environment.ts --only "$arena" --preserve-textures
done
```

The scripts update the checked-in authoring sources and dedicated native outputs. They do not
rewrite the shared runtime manifests, item thumbnails, Frontier layout or legacy compatibility
URLs. Regenerate those integration artifacts after all character, prop and map outputs are ready.
