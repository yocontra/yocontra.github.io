# Authored near saguaro prototype

The yard near cactus has 13,236 triangles, continuous ribbed trunk and branch, rounded same-skin crowns, 114 clusters / 912 modeled spine needles. The geometry was authored procedurally in Blender. Original `frontier-cacti.glb` supplies the retained envelope and pivot. Far/shared instances and collision are unchanged.

`frontier-cactus-near.glb` is the portable local-space install source with all three PNG PBR maps embedded. `near-source.blend` is the editable authored mesh. `tile-source.blend` contains the authored high surface with baked image pixels packed. PNGs preserve the valid existing authored tile bake; they were not rebaked for the geometry revision. Both blends have no unresolved external file image dependencies.

To rebuild geometry from these persisted sources, from the repository root copy `authoring-recipe.json` to an external stage as `authoring-job.json`, then run Blender 5.3 `--background --factory-startup --threads 2 --python tools/content/frontier-cactus-authoring.py -- --stage EXTERNAL_STAGE`. The recipe records relative repository paths and exact hashes. It reuses the persisted map bake and recreates near geometry with seed 20261115. It does not depend on an old published native GLB or a staging directory. The script also retains its full high-tile bake path when no `reusedMaps` are specified.

Frontier authoring automatically installs this portable GLB through `replaceCactusPrototype` after building the map layout. The installer creates cloud UV1 using actual world X/Z divided by 1024, preserving UV0/maps and every other node/resource. World UV1 deliberately belongs to the placement, rather than this portable local source. The model is used for the yard instance; far models and other placements retain their existing meshes.

