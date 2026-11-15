# PlayCanvas 2.23.3 batch material ownership

`bun install` applies the versioned patch through `patchedDependencies`.

Dynamic batching clones a material for each batch. The engine destroys the batch mesh
instance without destroying that clone, retaining its material uniform buffer across
equipment visibility changes and application teardown. The patch records ownership at
the clone's creation and releases it when the batch is destroyed. Source materials,
static batches and shared textures remain caller-owned.

The patch covers production, debug and profiler ESM and UMD entry points. Keep them
consistent when updating the engine. Remove the patch only after the replacement engine
passes `tests/runtime/playcanvas-batch-lifecycle.test.ts` and actual WebGL teardown with
zero retained buffers. Native QA must verify the executing dependency code; an existing
Vite optimizer cache can retain the unpatched engine after installation.
