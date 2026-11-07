/** Catalog hat details are geometry, so the item retains its identity at any texture setting. */
import {
  BoxGeometry,
  type BufferGeometry,
  CatmullRomCurve3,
  type Group,
  Mesh,
  MeshStandardMaterial,
  TubeGeometry,
  Vector3,
} from 'three'

export type HatDetail = 'rattler' | 'bronze' | 'holed'
export const hatDetailFor = (id: string): HatDetail | undefined => {
  if (id === 'hat.rattler-band') {
    return 'rattler'
  }
  if (id === 'hat.bronze-band') {
    return 'bronze'
  }
  return id === 'hat.holed-stetson' ? 'holed' : undefined
}

interface HatSurface {
  felt: BufferGeometry
  group: Group
  bandY: number
  radius: number
  wall: (y: number) => number
}

function material(color: number, metal = false): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({
    color,
    roughness: metal ? 0.4 : 0.8,
    metalness: metal ? 0.8 : 0,
  })
  mat.userData.swatch = metal ? 'metal' : 'leather'
  mat.userData.rim = metal ? 1.2 : 0.65
  return mat
}

/** A real crown opening and the scorched, uneven felt edge of a bullet strike. */
function bulletHole(h: HatSurface): void {
  const pos = h.felt.getAttribute('position')
  const ix = h.felt.getIndex()
  if (!ix) {
    return
  }
  const keep: number[] = []
  for (let i = 0; i < ix.count; i += 3) {
    const a = ix.getX(i)
    const b = ix.getX(i + 1)
    const c = ix.getX(i + 2)
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3
    const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3
    if (z < 0 || ((x + 0.025) / 0.015) ** 2 + ((y - 0.085) / 0.017) ** 2 > 1) {
      keep.push(a, b, c)
    }
  }
  h.felt.setIndex(keep)
  const edge: Vector3[] = []
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2
    const r = 1 + 0.12 * Math.sin(i * 7)
    const x = -0.025 + Math.sin(a) * 0.015 * r
    const y = 0.085 + Math.cos(a) * 0.017 * r
    const wall = h.wall(y) / 0.96
    const z = Math.sqrt(Math.max(0, wall * wall - (x / 0.86) ** 2)) + 0.0008
    edge.push(new Vector3(x, y, z))
  }
  h.group.add(
    new Mesh(
      new TubeGeometry(new CatmullRomCurve3(edge, true), 40, 0.0018, 4, true),
      material(0x29_20_15),
    ),
  )
}

/** Apply before the hat is merged; details remain part of its one shared draw. */
export function detailHat(h: HatSurface, detail: HatDetail | undefined): void {
  if (detail === 'holed') {
    bulletHole(h)
    return
  }
  if (!detail) {
    return
  }
  const count = detail === 'rattler' ? 28 : 12
  const dark = material(0x3b_2b_1b)
  const light = material(detail === 'rattler' ? 0xa8_8b_58 : 0xb4_7d_38, detail === 'bronze')
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2
    const radius = h.radius + 0.004
    const m = new Mesh(
      new BoxGeometry(
        detail === 'rattler' ? 0.011 : 0.018,
        detail === 'rattler' ? 0.013 : 0.018,
        0.0025,
      ),
      light,
    )
    m.position.set(Math.sin(a) * radius * 0.86, h.bandY, Math.cos(a) * radius)
    m.rotation.y = a
    m.rotation.z = detail === 'rattler' ? Math.PI / 4 : 0
    h.group.add(m)
    if (detail === 'rattler') {
      const scale = new Mesh(new BoxGeometry(0.005, 0.007, 0.003), dark)
      scale.position
        .copy(m.position)
        .add(new Vector3(Math.sin(a) * 0.0017, 0, Math.cos(a) * 0.0017))
      scale.rotation.copy(m.rotation)
      h.group.add(scale)
    }
  }
}
