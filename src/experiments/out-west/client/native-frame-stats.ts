/** Read only on demand by the explicitly enabled QA snapshot; never enables engine profiling. */
import type { AppBase } from 'playcanvas'

export function nativeFrameStats(app: AppBase | undefined) {
  if (!app) {
    return null
  }
  const { stats, renderer, graphicsDevice } = app
  const { width, height } = graphicsDevice.canvas
  return {
    source: 'PlayCanvas AppStats: render application only',
    frameId: app.frame,
    sampledAtMs: performance.now(),
    // Latest completed phases, not atomic frame records or additive CPU totals.
    cpuMs: {
      update: stats.cpuUpdateTime,
      render: stats.cpuRenderTime,
      systemUpdate: stats.cpuSystemUpdateTime,
      systemPostUpdate: stats.cpuSystemPostUpdateTime,
      animation: stats.cpuAnimationTime,
      physics: app.systems.rigidbody ? stats.cpuPhysicsTime : null,
    },
    frame: {
      elapsedMs: stats.frame.ms,
      simulationDtSeconds: stats.frame.dt,
      updateStartMs: stats.frame.updateStart,
      renderStartMs: stats.frame.renderStart,
    },
    renderCounters: {
      // These native renderer counters accumulate in release builds. Differences between
      // snapshots describe the measured interval without enabling PlayCanvas profiling.
      forward: renderer._forwardDrawCalls,
      shadow: renderer._shadowDrawCalls,
      skinned: renderer._skinDrawCalls,
    },
    resources: {
      canvas: { width, height },
      loadedModels: app.assets.filter((asset) => asset.type === 'container' && asset.loaded).length,
      textures: graphicsDevice.textures.size,
      buffers: graphicsDevice.buffers.size,
      textureBytes: stats.vramTextureBytes,
      vertexBytes: stats.vramVertexBufferBytes,
      indexBytes: stats.vramIndexBufferBytes,
    },
    // Release engine does not publish detailed renderer phase timings.
    unavailable: ['skin', 'morph', 'cull', 'sort', 'shadow', 'renderTargetCreation'],
    gpuMs: stats.gpuFrameTime ?? null,
  }
}
