import type { ItemId } from '../../../data/catalog.ts'
import type { Look } from '../../../data/outlaws.ts'
import type { HolsterLook } from '../../../scene/kit.ts'

export type VatLook = Look & {
  offGun?: boolean
  bandana?: number
  holster?: HolsterLook
  catalogMoustache?: number
  catalogMoustacheStyle?: Look['moustacheStyle']
  spurs?: ItemId
}

/** Geometry, rather than the rider palette, owns a VAT cache entry. */
export function silhouetteKey(look: VatLook): string {
  return JSON.stringify([
    look.base,
    look.coat ?? null,
    look.coatCut ?? null,
    look.poncho ?? null,
    look.vest ?? null,
    look.bandoliers ?? false,
    look.offGun ?? false,
    look.bandana ?? null,
    look.star ?? false,
    look.holster ?? null,
    look.catalogMoustache ?? null,
    look.gloves ?? null,
  ])
}

export function silhouetteLook(look: VatLook): VatLook {
  const out: VatLook = { base: look.base, tint: {}, scale: 1, skin: 'tan' }
  for (const key of [
    'coat',
    'coatCut',
    'poncho',
    'vest',
    'bandoliers',
    'offGun',
    'bandana',
    'star',
    'holster',
    'catalogMoustache',
    'gloves',
  ] as const) {
    const value = look[key]
    if (value !== undefined) {
      Object.assign(out, { [key]: value })
    }
  }
  if (look.catalogMoustache !== undefined) {
    out.moustache = look.catalogMoustache
    out.moustacheStyle = 'handlebar'
  }
  return out
}
