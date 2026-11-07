/** The same complete dressed avatar is used by the animated crowd and physical corpses. */
import type { Assets } from '../../../engine/assets.ts'
import { castActor } from '../../../scene/cast.ts'
import { equippedGun, fitCatalogSpurs } from '../../../scene/loadout.ts'
import { revolverDef } from '../../../scene/revolver.ts'
import type { PlayerLook } from '../looks.ts'
import { prepareCorpseFit } from './corpse-rig.ts'

export function dressedRider(assets: Assets, look: PlayerLook) {
  const actor = castActor(assets, {
    look: look.look,
    hat: look.hat,
    hatColor: look.hatColor,
    hatDetail: look.hatDetail,
    gun: equippedGun(revolverDef(0.32, 'mid'), look.gun),
    offGun: look.look.offGun ?? false,
    bandana: look.look.bandana,
    holster: look.look.holster,
  })
  fitCatalogSpurs(actor, look.spurs)
  actor.hat?.scale.multiplyScalar(look.hatScale)
  prepareCorpseFit(actor)
  return actor
}
export function copyPlayerLook(look: PlayerLook): PlayerLook {
  return {
    ...look,
    look: structuredClone(look.look),
    top: look.top.clone(),
    bottom: look.bottom.clone(),
    sleeves: look.sleeves.clone(),
    hair: look.hair.clone(),
    skin: look.skin.clone(),
  }
}
