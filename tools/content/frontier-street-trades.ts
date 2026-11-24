/** Small Blender fittings attached to solid wall bays and existing street furniture. */
import { type Document, Mesh, type vec3 } from '@gltf-transform/core'
import { copyToDocument, getBounds } from '@gltf-transform/functions'
import type { Cover, TownLayout } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { frontierIO } from './frontier-geometry.ts'

type WallArt =
  | 'stable-bridles'
  | 'farrier-shoe-rack'
  | 'wheelwright-spare'
  | 'icehouse-tongs'
  | 'depot-wall-clock'
type TableArt =
  | 'cord-bound-parcels'
  | 'travellers-valise'
  | 'gathered-mail-sacks'
  | 'assayers-pan'
  | 'joiners-bench-tools'
  | 'grocers-apple-basket'
  | 'stock-trough-pump'

interface WallSite {
  art: WallArt
  owner: string
  side: 'n' | 's'
  at: number
  y: number
}

const walls: WallSite[] = [
  { art: 'stable-bridles', owner: 'livery', side: 's', at: 3.73, y: 0.91 },
  { art: 'farrier-shoe-rack', owner: 'smithy', side: 'n', at: 1.06, y: 0.98 },
  { art: 'wheelwright-spare', owner: 'smithy', side: 'n', at: 11.13, y: 0.083 },
  { art: 'stable-bridles', owner: 'hay_barn', side: 's', at: 9.35, y: 0.8 },
  { art: 'icehouse-tongs', owner: 'icehouse', side: 's', at: 4.8, y: 0.93 },
  { art: 'wheelwright-spare', owner: 'carriage_shed', side: 'n', at: 10.54, y: 0.023 },
  { art: 'depot-wall-clock', owner: 'depot', side: 's', at: 14.98, y: 2.27 },
]

type SupportKind = Extract<Cover['kind'], 'bench' | 'workbench' | 'table' | 'trough'>
interface CounterSite {
  art: TableArt
  kind: SupportKind
  x: number
  z: number
  offsetX: number
  offsetZ?: number
  turn?: boolean
}

const counters: CounterSite[] = [
  { art: 'travellers-valise', kind: 'bench', x: 45.5, z: 44, offsetX: -0.51, offsetZ: 0.065 },
  { art: 'assayers-pan', kind: 'bench', x: 83.5, z: 42, offsetX: -0.1 },
  { art: 'cord-bound-parcels', kind: 'bench', x: 60, z: 59.5, offsetX: -0.39, turn: true },
  { art: 'grocers-apple-basket', kind: 'bench', x: 60, z: 59.5, offsetX: 0.43 },
  { art: 'gathered-mail-sacks', kind: 'bench', x: 15, z: 94.5, offsetX: -0.45 },
  { art: 'travellers-valise', kind: 'bench', x: 15, z: 94.5, offsetX: 0.54, turn: true },
  { art: 'gathered-mail-sacks', kind: 'bench', x: 13.5, z: 60.5, offsetX: 0.55, turn: true },
  { art: 'cord-bound-parcels', kind: 'table', x: 6.6, z: 66, offsetX: -0.39 },
  { art: 'assayers-pan', kind: 'table', x: 85.6, z: 38, offsetX: 0.32 },
  { art: 'joiners-bench-tools', kind: 'workbench', x: 44.5, z: 94.5, offsetX: -0.51 },
  { art: 'joiners-bench-tools', kind: 'workbench', x: 80, z: 91.5, offsetX: 0.54, turn: true },
  { art: 'stock-trough-pump', kind: 'trough', x: 7, z: 13.2, offsetX: -0.8 },
]

function fitsSpan(low: number, high: number, span: number, shift: number): boolean {
  return low + shift >= -span / 2 - 0.001 && high + shift <= span / 2 + 0.001
}

/** These are visual attachments to existing furniture and shallow wall relief, in town coordinates. */
export async function installStreetTrades(
  doc: Document,
  layout: TownLayout,
  path: string,
): Promise<void> {
  const art = await frontierIO.read(path)
  const prototypes = new Map(
    art
      .getRoot()
      .listNodes()
      .map((node) => [node.getName(), node]),
  )
  const meshes = copyToDocument(doc, art, art.getRoot().listMeshes())
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]
  const town = scene?.listChildren().find((node) => node.getName() === 'town')
  if (!town) {
    throw new Error('Missing Perdition town root for the street fittings')
  }
  const group = doc.createNode('Perdition street trades')
  town.addChild(group)
  function fittingFor(name: TableArt | WallArt) {
    const original = prototypes.get(name)
    const source = original?.getMesh()
    const mesh = source && meshes.get(source)
    if (!(original && mesh instanceof Mesh)) {
      throw new Error(`Missing Blender street fitting ${name}`)
    }
    const { min, max } = getBounds(original)
    return {
      min,
      max,
      place(site: string, position: vec3, faceNorth: boolean) {
        const node = doc
          .createNode(`street-trade:${site}:${name}`)
          .setMesh(mesh)
          .setTranslation(position)
        if (faceNorth) {
          node.setRotation([0, 1, 0, 0])
        }
        group.addChild(node)
      },
    }
  }
  for (const { art: name, owner, side, at, y } of walls) {
    const building = layout.buildings.find((entry) => entry.id === owner)
    if (!building) {
      throw new Error(`Missing wall at ${owner}`)
    }
    const fitting = fittingFor(name)
    const north = side === 'n'
    const left = at + (north ? -fitting.max[0] : fitting.min[0])
    const right = at + (north ? -fitting.min[0] : fitting.max[0])
    // Leave space for the full door or window trim, including its projecting casing.
    const openings = [
      ...building.doors.filter((door) => (door.y0 ?? 0) < 0.1),
      ...(building.windows ?? []).filter((window) => window.floor === 0),
    ]
    if (
      left < 0 ||
      right > building.w ||
      openings.some(
        (opening) =>
          opening.side === side &&
          left < opening.at + opening.width + 0.15 &&
          right > opening.at - 0.15,
      )
    ) {
      throw new Error(`Street fitting intersects an opening at ${owner}:${at}`)
    }
    const z = building.z + (north ? 0.002 : building.d - 0.002)
    fitting.place(owner, [building.x + at, y, z], north)
  }
  for (const { art: name, kind, x, z, offsetX, offsetZ = 0, turn = false } of counters) {
    const support = layout.cover.find((item) => item.kind === kind && item.x === x && item.z === z)
    if (!support || support.top === undefined) {
      throw new Error(`Missing ${kind} at ${x}, ${z} for ${name}`)
    }
    const fitting = fittingFor(name)
    const cx = x + support.w / 2 + offsetX
    const cz = z + support.d / 2 + offsetZ
    const heading = turn ? -1 : 1
    if (
      !(
        fitsSpan(fitting.min[0], fitting.max[0], support.w, heading * offsetX) &&
        fitsSpan(fitting.min[2], fitting.max[2], support.d, heading * offsetZ)
      )
    ) {
      throw new Error(`Street fitting overhangs ${kind} at ${x}, ${z}`)
    }
    fitting.place(`${kind}-${x}-${z}`, [cx, support.top, cz], turn)
  }
}
