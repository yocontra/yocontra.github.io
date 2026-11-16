# Freight crate prefabs

43 exact family/dimension profiles with near/far tiers. Standard glTF local meshes are shared under translation-only cells. Atlas PNG bytes are the accepted ARTREV2 maps at1024px/m. The library contains editable-profile-derived condensed geometry, not a new bake. Source authoring code remains tools/content/freight-crates-authoring.py; profiles.json records exact inputs.

`profiles.json` is a generated 2.5 MiB geometry/contact ledger. It is excluded from source formatting; the prefab reader verifies its referenced GLB/map hashes and the installer checks the geometry contracts before publication.

After Frontier layout and its ordinary dedup/weld/prune step, before writing frontier.glb:

`const prefabs = await readFreightPrefabs(join(SOURCE, 'freight-crates'))`
`installFreightCrates(g.doc, prefabs, packFreight(plan.layout.cover))`

Import readFreightPrefabs/installFreightCrates from tools/content/freight-crates-install.ts, packFreight from freight-crates-contract.ts. Existing material-local native cloud UV1 hook remains required. No Blender or texture encoder is needed for this canonical install. The existing native exporter encodes new PNGs with its ordinary shared codec. New dimensions missing from library.glb explicitly require profile regeneration; existing profile geometry and accepted maps can be reused unchanged. All collision, envelope, closed-solid, joint, contact and LOD rules remain active.

Wood atlas uses Poly Haven weathered_planks (CC0, https://polyhaven.com/a/weathered_planks); hardware uses existing Poly Haven rusty_metal_02 CC0. scan-provenance.json retains source/map hashes and metadata links. Stencils and irregular endgrain treatment are original authored atlas content.

For a new staged native comparison, run `OW_FREIGHT_DIRECTORY=/absolute/job OW_ORIGIN=http://127.0.0.1:4389 bun tools/test-playcanvas-freight-crates.ts` against a local development server. The job must include the frozen source/assembly receipts produced by the candidate authoring tool. Review images go into the job's `native-review` directory; set `OW_EVIDENCE` to use another external directory.
