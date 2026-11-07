import type { Object3D } from 'three'
import type { HatKey, Look } from '../data/outlaws.ts'
import type { Assets } from '../engine/assets.ts'
import { Actor, type ActorOpts } from './actor.ts'
import type { HatDetail } from './hat-detail.ts'
import type { HolsterLook } from './kit.ts'
import { hairDonor } from './person.ts'

export interface CastSpec {
  look: Look
  paletteSlots?: ActorOpts['paletteSlots']
  hat: HatKey
  hatColor: number
  hatDetail?: HatDetail | undefined
  bandana?: number | undefined
  holster?: HolsterLook | undefined
  gun?: Object3D | null
  offGun?: boolean
  rifle?: Object3D | null
}

/**
 * Build an outlaw from his look: one whole base character (they all share the
 * player's rig and clips), recoloured, uniformly scaled and dressed in fitted
 * clothes. Every file the look needs must already be loaded.
 */
export function castActor(assets: Assets, s: CastSpec): Actor {
  const L = s.look
  const base = assets.bodyNow(L.base)
  if (!base) {
    throw new Error(`model ${L.base} not loaded`)
  }
  const donor = hairDonor(L.base, L.hair)
  return new Actor(base, {
    base: L.base,
    // Bases without clips of their own play the player's (same skeleton).
    clips: base.animations.length > 0 ? base.animations : assets.player.animations,
    tint: L.tint,
    paletteSlots: s.paletteSlots,
    hat: s.hat,
    hatColor: s.hatColor,
    hatDetail: s.hatDetail,
    bandana: L.mask ? undefined : s.bandana,
    gun: s.gun ?? null,
    holster: s.holster,
    offGun: s.offGun ?? false,
    rifle: s.rifle ?? null,
    scale: L.scale,
    coat: L.coat,
    coatCut: L.coatCut,
    poncho: L.poncho,
    vest: L.vest,
    moustache: L.moustache,
    moustacheStyle: L.moustacheStyle,
    beard: L.beard,
    beardStyle: L.beardStyle,
    sideburns: L.sideburns,
    stubble: L.stubble,
    bandoliers: L.bandoliers,
    star: L.star,
    mask: L.mask ? (s.bandana ?? 0x2a_1a_12) : undefined,
    eyepatch: L.eyepatch,
    scar: L.scar,
    gloves: L.gloves,
    skin: L.skin,
    hair: L.hair,
    hairFrom: donor ? assets.bodyNow(donor) : null,
    build: L.build,
    face: L.face,
    stance: L.stance,
    seed: `${L.base}/${s.hat}/${s.hatColor}/${Object.values(L.tint).join(',')}`,
  })
}
