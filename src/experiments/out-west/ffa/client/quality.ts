import type { Quality } from '../../engine/tiers.ts'
import type { ViewPolicy } from './view.ts'

const NEAR: Record<Quality, number> = { high: 16, medium: 16, floor: 3, legacy: 2 }

/** Every rider gets either a real shadow or a blob, including the direct-render phone tiers. */
export function crowdBudget(tier: Quality, shadows: boolean): { near: number; casters: number } {
  return { near: NEAR[tier], casters: shadows ? 6 : 0 }
}

/** Weather tightens the active view's haze; it must finish before geometry clips out. */
export function weatherFog(
  policy: ViewPolicy,
  storm: number,
  out: { near: number; far: number },
  cameraFar = policy.far,
): void {
  const w = Math.min(1, Math.max(0, storm))
  const far = Math.min(policy.fogFar, policy.far - 2, cameraFar - 2)
  const near = Math.min(policy.fogNear, far * 0.8)
  out.near = near * (1 - w * (1 - 55 / 120))
  out.far = far * (1 - w * (1 - 140 / 260))
}
