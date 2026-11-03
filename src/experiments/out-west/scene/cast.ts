import type { Object3D } from 'three'
import type { HatKey, Look } from '../data/outlaws.ts'
import type { Assets } from '../engine/assets.ts'
import { Actor } from './actor.ts'

export interface CastSpec {
  look: Look
  hat: HatKey
  hatColor: number
  bandana?: number | undefined
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
  return new Actor(base, {
    base: L.base,
    // Bases without clips of their own play the player's (same skeleton).
    clips: base.animations.length > 0 ? base.animations : assets.player.animations,
    tint: L.tint,
    hat: s.hat,
    hatColor: s.hatColor,
    bandana: L.mask ? undefined : s.bandana,
    gun: s.gun ?? null,
    offGun: s.offGun ?? false,
    rifle: s.rifle ?? null,
    scale: L.scale,
    coat: L.coat,
    poncho: L.poncho,
    moustache: L.moustache,
    beard: L.beard,
    bandoliers: L.bandoliers,
    star: L.star,
    mask: L.mask ? (s.bandana ?? 0x2a_1a_12) : undefined,
    seed: `${L.base}/${s.hat}/${s.hatColor}/${Object.values(L.tint).join(',')}`,
  })
}
