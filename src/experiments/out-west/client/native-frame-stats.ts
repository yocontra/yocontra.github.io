/** Read only on demand by the explicitly enabled QA snapshot; never enables engine profiling. */
import type { AppBase } from 'playcanvas'

export function nativeFrameStats(app: AppBase | undefined) {
  if (!app) {
    return null
  }
  const stats = app.stats
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
    // Release engine does not publish detailed renderer phase timings.
    unavailable: ['skin', 'morph', 'cull', 'sort', 'shadow', 'renderTargetCreation'],
    gpuMs: stats.gpuFrameTime ?? null,
  }
}
