/** Explicit authored attachment seats; these identifiers are part of the baked glTF contract. */
import type { GraphNode } from 'playcanvas'
export type GunHand = 'L' | 'R'
export interface WeaponMount {
  node: GraphNode
  drawn: boolean
  hand?: GunHand | undefined
  weapon?: 'rifle' | 'shotgun' | undefined
}
interface MountPoint {
  bone: string
  mode: 'drawn' | 'holstered' | 'long' | 'accessory'
  hand?: GunHand | undefined
}
const points: ReadonlyMap<string, MountPoint> = new Map([
  ['mount.WristR.drawn', { bone: 'WristR', mode: 'drawn', hand: 'R' }],
  ['mount.WristL.drawn', { bone: 'WristL', mode: 'drawn', hand: 'L' }],
  ['mount.UpperLegR.holstered', { bone: 'UpperLegR', mode: 'holstered', hand: 'R' }],
  ['mount.UpperLegL.holstered', { bone: 'UpperLegL', mode: 'holstered', hand: 'L' }],
  ['mount.Chest.long', { bone: 'Chest', mode: 'long' }],
  ['mount.Head.accessory', { bone: 'Head', mode: 'accessory' }],
  ['mount.FootL.accessory', { bone: 'FootL', mode: 'accessory' }],
  ['mount.FootR.accessory', { bone: 'FootR', mode: 'accessory' }],
])
export function authoredMounts(model: GraphNode): { node: GraphNode; point: MountPoint }[] {
  return model
    .find((node) => points.has(node.name))
    .flatMap((node) => {
      const point = points.get(node.name)
      return point ? [{ node, point }] : []
    })
}
