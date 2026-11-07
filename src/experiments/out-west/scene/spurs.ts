/** Metal spur rowels with cut points and a heel shank, rather than solid polygonal disks. */
import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Shape,
  SphereGeometry,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const cache = new Map<string, BufferGeometry>()
export function spurGeometry(points: number, jingles: boolean): BufferGeometry {
  const key = `${points}/${jingles}`
  const have = cache.get(key)
  if (have) {
    return have
  }
  const shape = new Shape()
  for (let i = 0; i < points * 2; i++) {
    const angle = (i / (points * 2)) * Math.PI * 2
    const radius = i % 2 === 0 ? 0.028 : 0.013
    const x = Math.sin(angle) * radius
    const y = Math.cos(angle) * radius
    if (i === 0) {
      shape.moveTo(x, y)
    } else {
      shape.lineTo(x, y)
    }
  }
  shape.closePath()
  const rowel = new ExtrudeGeometry(shape, {
    depth: 0.005,
    steps: 1,
    bevelEnabled: true,
    bevelThickness: 0.0007,
    bevelSize: 0.0007,
    bevelSegments: 1,
  })
    .translate(0, 0, -0.0025)
    .rotateX(Math.PI / 2)
  const hub = new CylinderGeometry(0.005, 0.005, 0.012, 10)
  const shank = new BoxGeometry(0.008, 0.009, 0.05).translate(0, 0, 0.027)
  const parts: BufferGeometry[] = [rowel, hub, shank]
  if (jingles) {
    for (const side of [-1, 1]) {
      parts.push(
        new SphereGeometry(0.0055, 8, 6).scale(0.65, 1, 1.4).translate(0, side * 0.009, 0.026),
      )
    }
  }
  const geometry = mergeGeometries(
    parts.map((part) => (part.index ? part.toNonIndexed() : part)),
    false,
  )
  if (!geometry) {
    throw new Error('Could not build spur')
  }
  cache.set(key, geometry)
  return geometry
}
