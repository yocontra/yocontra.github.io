/** Stamped flowers and silver conchos follow the fitted holster's curved leather sleeve. */
import { Vector3 } from 'three'
import { GeoBuilder } from './geo.ts'
import { EASE, type GunAnatomy, LEATHER } from './holster.ts'
import type { HolsterLook } from './kit.ts'

export function holsterDetail(
  a: GunAnatomy,
  look: HolsterLook,
): { geo: ReturnType<GeoBuilder['build']>; metal: boolean }[] {
  if (!look.detail) {
    return []
  }
  const b = new GeoBuilder()
  const x0 = a.mouthX
  const length = a.muzzle.x + 0.012 - x0
  const surface = (x: number, y: number, side: number): Vector3 => {
    const t = Math.min(1, Math.max(0, ((x - x0) / length) * 2))
    const k = t * t * (3 - 2 * t)
    const cy = a.cylinder.cy + (a.barrel.cy - a.cylinder.cy) * k
    const ry = a.cylinder.hy + (a.barrel.hy - a.cylinder.hy) * k + EASE + LEATHER
    const rz = a.cylinder.hz + (a.barrel.hz - a.cylinder.hz) * k + EASE + LEATHER
    return new Vector3(
      x,
      cy + y,
      side * (rz * Math.sqrt(Math.max(0.1, 1 - (y / ry) ** 2)) + 0.0038),
    )
  }
  for (const side of [-1, 1]) {
    for (const t of [0.23, 0.5, 0.76]) {
      const x = x0 + length * t
      if (look.detail === 'conchos') {
        const center = surface(x, 0, side)
        for (let i = 0; i < 16; i++) {
          const a0 = (i / 16) * Math.PI * 2
          const a1 = ((i + 1) / 16) * Math.PI * 2
          const p = surface(x + Math.cos(a0) * 0.009, Math.sin(a0) * 0.009, side)
          const q = surface(x + Math.cos(a1) * 0.009, Math.sin(a1) * 0.009, side)
          const hub = center.clone().add(new Vector3(0, 0, side * 0.0018))
          if (side > 0) {
            b.tri(hub, p, q, 0xd8_dc_e4)
          } else {
            b.tri(hub, q, p, 0xd8_dc_e4)
          }
        }
      } else {
        // Five pressed petals and a stem: darker tooling is legible on russet leather.
        for (let i = 0; i < 40; i++) {
          const a0 = (i / 40) * Math.PI * 2
          const a1 = ((i + 1) / 40) * Math.PI * 2
          const r0 = 0.008 + 0.004 * Math.cos(a0 * 5)
          const r1 = 0.008 + 0.004 * Math.cos(a1 * 5)
          const p = surface(x + Math.cos(a0) * r0, Math.sin(a0) * r0, side)
          const q = surface(x + Math.cos(a1) * r1, Math.sin(a1) * r1, side)
          const edge = new Vector3(q.y - p.y, p.x - q.x, 0).normalize().multiplyScalar(0.0008)
          b.quad(
            p.clone().add(edge),
            p.clone().sub(edge),
            q.clone().sub(edge),
            q.clone().add(edge),
            0x45_25_13,
          )
        }
      }
    }
  }
  return [{ geo: b.build(), metal: look.detail === 'conchos' }]
}
