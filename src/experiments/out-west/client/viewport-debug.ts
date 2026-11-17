/** On-demand viewport inspection; no per-frame sampling or separate resource owner. */
import type { Actors } from './actors.ts'
import type { GameApplication } from './application.ts'
import type { BreakableProps } from './environment-response.ts'
import { nativeFrameStats } from './native-frame-stats.ts'
import type { NativeRagdolls } from './ragdolls.ts'
import type { GameSession } from './viewport.ts'
import type { BreakableWindows } from './windows.ts'

export function viewportDebug({
  application,
  session,
  windows,
  actors,
  ragdolls,
  props,
}: {
  application: GameApplication | undefined
  session: GameSession | undefined
  windows: BreakableWindows | undefined
  actors: Actors | undefined
  ragdolls: NativeRagdolls | undefined
  props: BreakableProps | undefined
}) {
  return {
    fps: application?.quality.fps ?? 0,
    worstFps: application?.quality.worstFps ?? 0,
    pixelRatio: application?.quality.pixelRatio ?? 0,
    players: session?.players.size ?? 0,
    props: props?.stats() ?? { broken: 0, pieces: 0, bodies: 0 },
    windows: windows?.stats() ?? { total: 0, intact: 0, shards: 0 },
    actors: actors?.stats() ?? { loaded: 0, loading: 0, failed: 0, fallbacks: 0, visible: 0 },
    drawCalls: application?.app.stats.drawCalls.total ?? 0,
    ragdolls: ragdolls?.stats() ?? { active: 0, frozen: 0, bodies: 0 },
    ...(import.meta.env.PUBLIC_OW_PERF_HARNESS === '1'
      ? {
          nativeAppStats: nativeFrameStats(application?.app),
          camera: application?.camera.camera
            ? {
                position: application.camera.getPosition().toArray(),
                forward: application.camera.forward.toArray(),
                fov: application.camera.camera.fov,
                horizontalFov: application.camera.camera.horizontalFov,
              }
            : null,
          renderer: application
            ? { tier: application.tier, nativePost: application.post?.diagnostics() ?? null }
            : null,
        }
      : {}),
  }
}
