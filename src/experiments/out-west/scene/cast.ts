import type { Object3D } from 'three'
import type { HatKey, Look } from '../data/outlaws'
import type { Assets } from '../engine/assets'
import { Actor } from './actor'

export interface CastSpec {
  look: Look
  hat: HatKey
  hatColor: number
  bandana?: number | undefined
  gun?: Object3D | null
  offGun?: boolean
  rifle?: Object3D | null
}

/** Build an outlaw from his look. Every file the look needs must already be loaded. */
export function castActor(assets: Assets, s: CastSpec): Actor {
  const L = s.look
  const need = (k: Parameters<Assets['bodyNow']>[0]) => {
    const g = assets.bodyNow(k)
    if (!g) throw new Error(`model ${k} not loaded`)
    return g
  }
  const base = L.woman ? need('woman') : assets.player
  return new Actor(base, {
    tint: L.tint,
    hat: s.hat,
    hatColor: s.hatColor,
    bandana: L.mask ? undefined : s.bandana,
    gun: s.gun ?? null,
    offGun: s.offGun ?? false,
    rifle: s.rifle ?? null,
    parts: L.woman
      ? null
      : {
          head: { gltf: need(L.head), src: L.head },
          body: { gltf: need(L.body), src: L.body },
          legs: { gltf: need(L.legs), src: L.legs },
          feet: { gltf: need(L.feet), src: L.feet },
        },
    build: L.build,
    coat: L.coat,
    poncho: L.poncho,
    moustache: L.moustache,
    beard: L.beard,
    bandoliers: L.bandoliers,
    star: L.star,
    mask: L.mask ? (s.bandana ?? 0x2a1a12) : undefined,
    seed: `${L.head}/${L.body}/${L.legs}/${L.feet}/${s.hat}/${s.hatColor}`,
  })
}
