import { expect, test as it } from 'bun:test'
import { build } from 'bun'
import { AppBase, AppOptions, NullGraphicsDevice } from 'playcanvas'
import { nativeFrameStats } from '../../src/experiments/out-west/client/native-frame-stats.ts'

const relativeImport = /^\.\.?\//u
// NullGraphicsDevice leaves this optional platform service unset.
type OptionalGpuProfiler = NullGraphicsDevice['gpuProfiler'] | undefined

it('samples live native frame counters without enabling profiling or retaining mutable stats', () => {
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  app.init(options)
  const profiling = (device.gpuProfiler as OptionalGpuProfiler)?.enabled
  try {
    const initial = nativeFrameStats(app)
    expect(initial?.frameId).toBe(0)
    expect(initial?.cpuMs.render).toBe(0)
    expect(initial?.gpuMs).toBeNull()
    expect(initial?.cpuMs.physics).toBeNull()
    expect(initial?.unavailable).toContain('shadow')
    expect(initial?.resources).toEqual({
      canvas: { width: 1, height: 1 },
      loadedModels: 0,
      textures: 0,
      buffers: device.buffers.size,
      textureBytes: 0,
      vertexBytes: app.stats.vramVertexBufferBytes,
      indexBytes: app.stats.vramIndexBufferBytes,
    })
    expect(initial?.renderCounters).toEqual({ forward: 0, shadow: 0, skinned: 0 })
    app.update(1 / 60)
    app.render()
    const first = nativeFrameStats(app)
    expect(first?.frameId).toBe(1)
    expect(first?.frame.updateStartMs).toBeGreaterThan(0)
    expect(first?.frame.renderStartMs).toBeGreaterThanOrEqual(first?.frame.updateStartMs ?? 0)
    expect(first?.cpuMs.update).toBe(app.stats.cpuUpdateTime)
    expect(first?.cpuMs.render).toBe(app.stats.cpuRenderTime)
    app.update(1 / 60)
    expect(nativeFrameStats(app)?.frameId).toBe(2)
    expect(first?.frameId).toBe(1)
    expect(initial?.frame.updateStartMs).toBe(0)
    expect((device.gpuProfiler as OptionalGpuProfiler)?.enabled).toBe(profiling)
    expect(nativeFrameStats(undefined)).toBeNull()
  } finally {
    app.destroy()
  }
})

it('strips native frame diagnostics from ordinary browser bundles and retains them only for QA', async () => {
  const bundle = async (enabled: boolean) => {
    const result = await build({
      entrypoints: ['src/experiments/out-west/client/viewport.ts'],
      target: 'browser',
      minify: true,
      external: ['playcanvas'],
      // Exercise the real viewport gate and helper, without bundling unrelated game systems.
      plugins: [
        {
          name: 'viewport-dependencies',
          setup(plugin) {
            plugin.onResolve({ filter: relativeImport }, ({ path }) =>
              path.endsWith('/native-frame-stats.ts') || path.endsWith('/viewport-debug.ts')
                ? undefined
                : { path, external: true },
            )
          },
        },
      ],
      define: {
        'import.meta.env.PUBLIC_OW_PERF_HARNESS': JSON.stringify(enabled ? '1' : ''),
        'import.meta.env.DEV': 'false',
      },
    })
    expect(result.success).toBe(true)
    return result.outputs[0]?.text()
  }
  const ordinary = await bundle(false)
  const qa = await bundle(true)
  for (const marker of [
    'nativeAppStats',
    'sampledAtMs',
    'simulationDtSeconds',
    'gpuMs',
    'renderCounters',
    'loadedModels',
  ]) {
    expect(ordinary).not.toContain(marker)
    expect(qa).toContain(marker)
  }
})
