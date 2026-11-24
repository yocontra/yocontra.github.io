/** Explicit authored attachment seats; these identifiers are part of the baked glTF contract. */
import { type GraphNode, Mat4, Quat, Vec3 } from 'playcanvas'
import type { ItemId } from '../data/catalog.ts'
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

// Band seats measured on each head in the local Head joint coordinates (meters).
const riderToStandard = new Mat4().setTRS(
  new Vec3(-0.002, 0.04, 0.048),
  new Quat().setFromEulerAngles(2, 0, -2),
  new Vec3(1.17, 1.17, 1.17),
)
const standardToRider = new Mat4().setTRS(
  new Vec3(0.0031114, -0.0349555, -0.0345499),
  new Quat().setFromEulerAngles(-2, 0.07, 2),
  new Vec3(0.966184, 0.966184, 0.966184),
)

export function fitHatToOutfit(model: GraphNode, hat: ItemId, outfit: ItemId): void {
  const riderHat = hat === 'hat.battered-brim'
  const riderHead = outfit === 'outfit.trail-duds'
  if (riderHat === riderHead) {
    return
  }
  const mount = model.findByName('mount.Head.accessory')
  if (!mount) {
    throw new Error(`Missing head mount on ${hat}`)
  }
  const fit = new Mat4().mul2(
    riderHat ? riderToStandard : standardToRider,
    mount.getLocalTransform(),
  )
  mount.setLocalPosition(fit.getTranslation())
  mount.setLocalRotation(new Quat().setFromMat4(fit))
  mount.setLocalScale(fit.getScale())
}
