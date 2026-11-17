# PlayCanvas 2.23.3 native resource ownership

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

Vertex and index buffer constructors account for their allocation before a backend upload.
Their destruction now removes that allocation exactly once when the native device owns
the buffer, including Null or never-uploaded buffers. The backend destroy call remains
conditional on initialization; accounting subtracts the constructor allocation `numBytes`,
not a potentially larger backing ArrayBuffer. The prior batch material fix is unchanged.
Run `tests/runtime/playcanvas-buffer-lifecycle.test.ts` across all ESM/require variants
and full collision simulation teardown when updating the dependency.
