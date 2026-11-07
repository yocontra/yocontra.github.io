/** The false-front wall profile shared by its visible woodwork and cosmetic corpse contacts. */
import { Vector3 } from 'three'
import type { Building, Side, Surface, TownLayout } from '../sim/layout.ts'
import { frontOf } from '../sim/porches.ts'
import { PAINT } from './town-paint.ts'

export function falseFrontProfile(b: Building, front: Side) {
  const along = front === 'n' || front === 's'
  const len = along ? b.w : b.d
  const top = b.height + 1.8
  const shoulders: Partial<Record<Building['kind'], number>> = {
    saloon: 0.48,
    hotel: 0.22,
    general_store: 0.6,
    undertaker: 0.35,
    assay: 0.4,
    stage_line: 0.4,
  }
  const drop = shoulders[b.kind] ?? 0
  const inset = len * (b.kind === 'hotel' ? 0.12 : 0.2)
  const sections: readonly (readonly [number, number, number])[] =
    drop > 0
      ? [
          [0, inset, top - drop],
          [inset, len - inset, top],
          [len - inset, len, top - drop],
        ]
      : [[0, len, top]]
  const at = (a: number, out: number): Vector3 => {
    if (front === 'n') {
      return new Vector3(b.x + a, 0, b.z - out)
    }
    if (front === 's') {
      return new Vector3(b.x + a, 0, b.z + b.d + out)
    }
    if (front === 'e') {
      return new Vector3(b.x + b.w + out, 0, b.z + a)
    }
    return new Vector3(b.x - out, 0, b.z + a)
  }
  return { along, len, top, drop, sections, at }
}

/** These visible wall/cornice spans stand above the gameplay wall, but still stop a corpse. */
export function facadeSolids(layout: TownLayout): Surface[] {
  const solids: Surface[] = []
  const add = (center: Vector3, size: { w: number; d: number }, bottom: number, top: number) => {
    solids.push({
      x: center.x - size.w / 2,
      z: center.z - size.d / 2,
      w: size.w,
      d: size.d,
      bottom,
      top,
      kind: 'solid',
    })
  }
  for (const building of layout.buildings) {
    const paint = PAINT[building.kind]
    if (!paint.falseFront) {
      continue
    }
    const profile = falseFrontProfile(building, frontOf(building, layout))
    for (const [a0, a1, cap] of profile.sections) {
      const width = a1 - a0
      const center = profile.at((a0 + a1) / 2, 0)
      add(
        center,
        { w: profile.along ? width : 0.3, d: profile.along ? 0.3 : width },
        building.height,
        cap,
      )
      add(
        center,
        { w: profile.along ? width + 0.02 : 0.5, d: profile.along ? 0.5 : width + 0.02 },
        cap,
        cap + 0.2,
      )
    }
    if (paint.sign) {
      const height = profile.top - building.height - 0.85
      add(
        profile.at(profile.len / 2, 0.17),
        { w: profile.along ? 6.3 : 0.04, d: profile.along ? 0.04 : 6.3 },
        building.height + 0.02,
        building.height + height + 0.18,
      )
    }
  }
  return solids
}
