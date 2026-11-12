/** Replace the bank's oversized gallows lanterns with the authored period street lamp. */
import { type Document, type Mesh, type Node, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { mergeDocuments } from '@gltf-transform/functions'

/** Lantern glass centre in the lamp's authored space (post foot at the origin, bracket along +X). */
export const LAMP_GLASS = [0.6, 2.46, 0] as const
/** The lantern font's lowest point, which seats on a standard's cap. */
const LANTERN_FOOT = 2.225
const STANDARD = /^lantern-\d+$/u
const PARTS = {
  post: ['lamp-post', 'lamp-lantern', 'lamp-glass'],
  standard: ['lamp-lantern', 'lamp-glass'],
} as const

interface Placement {
  kind: 'post' | 'standard'
  position: [number, number, number]
  yaw: number
}

function yawQuaternion(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
}

/** World positions of the native lights that belong to each placed lantern. */
export function lampLights(placements: readonly Placement[]): [number, number, number][] {
  return placements.map(({ kind, position: [x, y, z], yaw }) => {
    const [gx, gy] = LAMP_GLASS
    const post = kind === 'post'
    return [
      Number((x + (post ? gx * Math.cos(yaw) : 0)).toFixed(3)),
      Number((y + gy - (post ? 0 : LANTERN_FOOT)).toFixed(3)),
      Number((z - (post ? gx * Math.sin(yaw) : 0)).toFixed(3)),
    ]
  })
}

function placement(node: Node): Placement | null {
  const name = node.getName()
  const [x = 0, y = 0, z = 0] = node.getTranslation()
  if (name.startsWith('postlantern-')) {
    // The bracket reaches over the street from the boardwalk edge.
    return { kind: 'post', position: [x, y, z], yaw: x < 0 ? 0 : Math.PI }
  }
  return STANDARD.test(name) ? { kind: 'standard', position: [x, y, z], yaw: Math.PI / 2 } : null
}

/** Each gallows is a lantern node and a post node at one spot; standards keep only their posts. */
function removeFixtures(document: Document): { parent: Node; placements: Placement[] } {
  const placements = new Map<string, Placement>()
  let parent: Node | null = null
  for (const node of document.getRoot().listNodes()) {
    const found = placement(node)
    if (!found) {
      continue
    }
    parent = node.getParentNode() ?? parent
    placements.set(`${found.position[0].toFixed(2)},${found.position[2].toFixed(2)}`, found)
    node.dispose()
  }
  if (!parent || placements.size === 0) {
    throw new Error('Bank lantern fixtures were not found')
  }
  return { parent, placements: [...placements.values()] }
}

async function mergeLamp(document: Document, lampPath: string): Promise<Map<string, Mesh>> {
  const root = document.getRoot()
  const lamp = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(lampPath)
  const merged = mergeDocuments(document, lamp)
  const [buffer, ...extra] = root.listBuffers()
  for (const accessor of root.listAccessors()) {
    accessor.setBuffer(buffer ?? null)
  }
  for (const unused of extra) {
    unused.dispose()
  }
  const meshes = new Map<string, Mesh>()
  for (const scene of lamp.getRoot().listScenes()) {
    for (const node of scene.listChildren()) {
      const copy = merged.get(node) as Node | undefined
      const mesh = copy?.getMesh()
      if (mesh) {
        meshes.set(node.getName(), mesh)
      }
      copy?.dispose()
    }
    merged.get(scene)?.dispose()
  }
  return meshes
}

/** Removes `postlantern-*` gallows and the bank standards' lantern heads, then places lamps. */
export async function dressStreetLamps(document: Document, lampPath: string): Promise<Placement[]> {
  const { parent, placements } = removeFixtures(document)
  const meshes = await mergeLamp(document, lampPath)
  for (const [index, { kind, position, yaw }] of placements.entries()) {
    const [x, y, z] = position
    // Standards carry only the lantern, centred on and seated onto the iron cap.
    const translation: [number, number, number] =
      kind === 'standard'
        ? [x - LAMP_GLASS[0] * Math.cos(yaw), y - LANTERN_FOOT, z + LAMP_GLASS[0] * Math.sin(yaw)]
        : [x, y, z]
    for (const part of PARTS[kind]) {
      const mesh = meshes.get(part)
      if (!mesh) {
        throw new Error(`Street lamp source is missing ${part}`)
      }
      parent.addChild(
        document
          .createNode(`streetlamp-${index}-${part.slice(5)}`)
          .setMesh(mesh)
          .setTranslation(translation)
          .setRotation(yawQuaternion(yaw)),
      )
    }
  }
  return placements
}
