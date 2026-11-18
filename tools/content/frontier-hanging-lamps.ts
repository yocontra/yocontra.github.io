/** Fit the bank's lantern bodies and carrying bails to Perdition's exterior walls. */
import type { Document, Mesh } from '@gltf-transform/core'
import { compactPrimitive, copyToDocument, prune, unpartition } from '@gltf-transform/functions'
import { Quat, Vec3 } from 'playcanvas'
import type { TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { structuralWalls } from './frontier-collision.ts'
import { LAMP_GLASS } from './street-lamps.ts'

const SCALE = 0.9
const BAIL = [0.6, 2.815, 0] as const

export function hangingLampSites(layout: TownLayout) {
  const walls = structuralWalls(layout)
  return layout.cover
    .filter(({ kind }) => kind === 'lantern')
    .map((cover) => {
      const x = cover.x + cover.w / 2
      const z = cover.z + cover.d / 2
      // The 85 mm plate must have support behind both rivets, clear of windows and doors.
      const support = walls
        .filter(
          (wall) =>
            x - 0.043 >= wall.x &&
            x + 0.043 <= wall.x + wall.w &&
            wall.y0 <= 2.96 &&
            wall.y1 >= 3.16,
        )
        .flatMap((wall) =>
          [wall.z, wall.z + wall.d]
            .filter((face) => Math.abs(Math.abs(z - face) - 0.175) < 1e-6)
            .map((face) => ({
              face,
              owner: wall.id.split(':')[0] ?? '',
              direction: z > face ? 1 : -1,
            })),
        )
      const site = support[0]
      if (support.length !== 1 || !site?.owner) {
        throw new Error(`Frontier lamp at ${x},${z} has no unique wall support`)
      }
      return { x, z, ...site }
    })
}

/** Extract the closed ring from the bank's packed post while retaining its baked UVs. */
function extractBail(source: Document): Mesh {
  const mesh = source
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'lamp-post')
    ?.getMesh()
  const primitive = mesh?.listPrimitives()[0]
  const positions = primitive?.getAttribute('POSITION')
  const indices = primitive?.getIndices()
  const vertices = indices?.getArray()
  if (!(mesh && primitive && positions && indices && vertices)) {
    throw new Error('Missing the bank lamp post')
  }
  const inside = (index: number) => {
    const p = positions.getElement(index, [])
    return BAIL.every(
      (value, axis) =>
        Math.abs((p[axis] ?? Number.POSITIVE_INFINITY) - value) < (axis === 0 ? 0.0061 : 0.0321),
    )
  }
  const faces: number[] = []
  for (let i = 0; i < vertices.length; i += 3) {
    const triangle = vertices.subarray(i, i + 3)
    if (triangle.every(inside)) {
      faces.push(...triangle)
    }
  }
  if (faces.length !== 192 * 3) {
    throw new Error('The bank lamp bail topology changed')
  }
  primitive.setIndices(indices.clone().setArray(Uint16Array.from(faces)))
  compactPrimitive(primitive)
  return mesh.setName('lamp-bail')
}

export async function installHangingLamps(
  document: Document,
  bankLamp: Document,
  layout: TownLayout,
) {
  const sites = hangingLampSites(layout)
  const root = document.getRoot()
  const old = root.listNodes().filter((node) => node.getName() === 'lantern_hanging')
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  const bankParts = bankLamp.getRoot().listNodes()
  const body = bankParts.find((node) => node.getName() === 'lamp-lantern')?.getMesh()
  const glass = bankParts.find((node) => node.getName() === 'lamp-glass')?.getMesh()
  if (!(scene && body && glass && old.length === sites.length && sites.length === 11)) {
    throw new Error('Incomplete Frontier or bank lamp fixtures')
  }
  // The glass node's origin is also the native light socket.
  const positions = glass.listPrimitives()[0]?.getAttribute('POSITION')
  if (!positions) {
    throw new Error('Missing the bank lamp glass positions')
  }
  for (let index = 0; index < positions.getCount(); index++) {
    const point = positions.getElement(index, [])
    positions.setElement(
      index,
      LAMP_GLASS.map((value, axis) => (point[axis] ?? 0) - value),
    )
  }
  const bail = extractBail(bankLamp)
  const copied = copyToDocument(document, bankLamp, [bail, body, glass])
  const pivot = new Vec3(...BAIL).mulScalar(SCALE)
  for (const { x, z, face, owner, direction } of sites) {
    const legacy = old.find((node) => {
      const [lx, , lz] = node.getWorldTranslation()
      return Math.abs(lx - x) + Math.abs(lz - z) < 1e-6
    })
    if (!legacy) {
      throw new Error(`Missing legacy lamp at ${owner}`)
    }
    const rotation = new Quat().setFromEulerAngles(0, 90 * direction, 0)
    const offset = rotation.transformVector(pivot)
    // The wall hook crosses the ring in its perpendicular plane, 14 mm above its centre.
    const lamp = document
      .createNode(`frontier-hanging-lamp:${owner}`)
      .setTranslation([x - offset.x, 2.833 - offset.y, face + direction * 0.225 - offset.z])
      .setRotation([rotation.x, rotation.y, rotation.z, rotation.w])
      .setScale([SCALE, SCALE, SCALE])
    for (const [part, name] of [
      [bail, 'lamp-bail'],
      [body, 'lamp-lantern'],
      [glass, 'frontier-lantern-glass'],
    ] as const) {
      const mesh = copied.get(part)
      if (!mesh) {
        throw new Error(`Missing copied Frontier lamp part ${name}`)
      }
      const node = document.createNode(name).setMesh(mesh as Mesh)
      if (part === glass) {
        node.setTranslation([...LAMP_GLASS])
      }
      lamp.addChild(node)
    }
    scene.addChild(lamp)
    const prefab = legacy.getParentNode()
    legacy.dispose()
    if (prefab?.getName() === 'prefab.lantern' && prefab.listChildren().length === 0) {
      prefab.dispose()
    }
  }
  await document.transform(
    prune({ keepLeaves: true, keepAttributes: true, keepSolidTextures: true }),
    unpartition(),
  )
}
