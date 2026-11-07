import type { AnimationClip, Object3D } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { BodyKey, HatKey } from '../data/outlaws.ts'
import type { HatDetail } from './hat-detail.ts'
import type { HolsterLook } from './kit.ts'
import type { PersonOpts } from './person.ts'
import type { DressOpts } from './rig.ts'

export interface ActorOpts extends PersonOpts, Pick<DressOpts, 'coatCut' | 'paletteSlots'> {
  /** Which whole base character this is (prunes its hard hat, crown, mohawk, backpack). */
  base?: BodyKey | null
  /** Animation clips, when the base file carries none (they share the player's rig). */
  clips?: readonly AnimationClip[] | null
  tint?: Readonly<Record<string, number>>
  hat?: HatKey | null
  hatColor?: number
  hatDetail?: HatDetail | undefined
  bandana?: number | undefined
  /** Revolver geometry to clone into the holster/hand. */
  gun?: Object3D | null
  /** Second gun (two-gun Delmer, Hardin). */
  offGun?: boolean
  rifle?: Object3D | null
  /** Uniform build: 1 = a 1.78 m man. */
  scale?: number
  coat?: number | undefined
  poncho?: number | undefined
  moustache?: number | undefined
  beard?: number | undefined
  bandoliers?: boolean | undefined
  star?: boolean | undefined
  mask?: number | undefined
  /** Seed for the subtle per-material colour/roughness variation. */
  seed?: string
  /** The holster cosmetic (leather colour, tooling, a buscadero drop loop). Looks only. */
  holster?: HolsterLook | undefined
}

export const actorLabel = (opts: ActorOpts): string =>
  `${opts.base ?? 'player'} ${opts.seed ?? ''}`.trim()
export const actorClips = (gltf: GLTF, opts: ActorOpts): readonly AnimationClip[] =>
  opts.clips && opts.clips.length > 0 ? opts.clips : gltf.animations
