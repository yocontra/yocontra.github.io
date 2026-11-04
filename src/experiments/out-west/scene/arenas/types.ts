/**
 * The duel arenas: where each act of the gauntlet is fought. The street (scene/world.ts) is the
 * default and the home of the finale; the others are built lazily, one at a time, when their act
 * begins, and disposed when the campaign moves on.
 *
 * An arena is presentation only. The duel lane is always the same strip of dirt down Z through
 * the origin (the duellists start back to back there and pace off along it), so the walk, the
 * wait, the call and the judged reaction never change. What changes: the buildings either side,
 * the vista at the lane's far end (the hero shot at the call looks down +Z), the lamps, where the
 * townsfolk stand and where the fake-out props are (the door, the dog, the horses, the crows).
 */
import type { Group, MeshStandardMaterial, Texture, Vector3, Vector4 } from 'three'
import type { LifeLayout } from '../townlife.ts'

export type ArenaId = 'street' | 'depot' | 'mission' | 'bank'

/** What the world lends an arena: its shared materials (no new shaders, no new textures). */
export interface ArenaCtx {
  /** Painted horizontal planks (vertex colours tint it). */
  wallMat: MeshStandardMaterial
  /** Vertical planks: trim, posts, boardwalks, roofs. */
  trimMat: MeshStandardMaterial
  /** Night-lit glass. */
  windowMat: MeshStandardMaterial
  /** The street's signboards (their relief and roughness maps are shared, not reloaded). */
  signMat: MeshStandardMaterial
  /** The masonry atlas: brick, sandstone, slate and tin, by UV cell (scene/masonry.ts). */
  civic: MeshStandardMaterial
  /** The street's dirt, for adobe and earthen walls. */
  ground: { map: Texture; normal: Texture }
  tier: string
}

export interface Arena {
  readonly id: ArenaId
  readonly root: Group
  /** Up to six lamp flames (x, y, z): the world's lantern lights move to them. */
  readonly lanterns: readonly (readonly [number, number, number])[]
  /** Light pools on the ground: x, z, radius, +flickering lamp / -steady window. */
  readonly pools: readonly Vector4[]
  /** Where the call's bell hangs (the sound comes from here). */
  readonly bell: Vector3
  readonly life: LifeLayout
  /** The ground shader's wagon ruts and hoofprints (1: the street's). */
  readonly ruts: number
  /** Window and lamp glow with the dusk (0..1), for anything the arena lights itself. */
  night?: (k: number) => void
  /** Free everything the arena made (never the world's shared materials or the kit's geometry). */
  dispose: () => void
}

export type BuildArena = (ctx: ArenaCtx) => Arena
