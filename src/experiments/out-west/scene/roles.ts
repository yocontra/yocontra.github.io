/**
 * Typed scene metadata. Code that needs to know *what* an object is (an effect, a decal, a
 * landform, a kit material) reads this instead of matching `object.name`, so renaming a mesh or
 * re-exporting a model cannot silently change behaviour. Set it where the object is created or
 * where an asset is loaded; the metadata travels with the model.
 */
import type { Object3D } from 'three'

export const ROLE = {
  /** Terrain: supports everything, never audited as a piece. */
  Land: 'land',
  /** Ground decals (the creek): supports, never floats. */
  Decal: 'decal',
  /** Additive/instanced effects: tracers, dust, shafts, casings. */
  Effect: 'effect',
  /** The sky dome and other unlit backdrops. */
  Backdrop: 'backdrop',
  /** Plant chunks, culled by distance in first person. */
  Flora: 'flora',
  /** Things that hang or fly by design (bags, lanterns, birds). */
  Hanging: 'hanging',
} as const
export type Role = (typeof ROLE)[keyof typeof ROLE]

export const SLOT = {
  /** Window glass, water and other see-through surfaces. */
  Glass: 'glass',
  /** The props library's shared kit material. */
  Kit: 'kit',
  /** Plain wrought iron (the clock tower's hands and rails). */
  Iron: 'iron',
  /** The town's board materials (wall, roof, wood), shaded as boards indoors. */
  Board: 'board',
  /** Character body materials, as baked by tools/build-characters.ts. */
  Skin: 'skin',
  Hair: 'hair',
  Brows: 'brows',
  Beard: 'beard',
  Eye: 'eye',
  Shirt: 'shirt',
  Sleeves: 'sleeves',
  Bracer: 'bracer',
  Pauldron: 'pauldron',
  Belt: 'belt',
  Pants: 'pants',
  Boots: 'boots',
} as const
export type Slot = (typeof SLOT)[keyof typeof SLOT]

/** Placement and behaviour flags a prop piece carries into the audits. */
export interface PieceFlags {
  /** Must stand on something (never just lean on a wall). */
  grounded?: boolean
  /** Stands on a deck when there is one (doors, benches, barrels). */
  onDeck?: boolean
  /** Its back belongs on a wall (kit windows, shutters, doors, balconies, lanterns). */
  wall?: boolean
  /** Hangs or flies by design (lanterns, bags, birds, clouds, tumbleweed). */
  hangs?: boolean
  /** Cosmetic doorway parts; never add blocking collision across their open passage. */
  nonBlocking?: boolean
  /** Live gameplay props (pickups, bags, the strongbox, guns, money). */
  live?: boolean
}

/** The flags carried in an object's `userData`. */
export const flagsOf = (o: Object3D): PieceFlags | undefined =>
  o.userData.pieceFlags as PieceFlags | undefined

export const markFlags = (o: Object3D, flags: PieceFlags): void => {
  o.userData.pieceFlags = flags
}

/** Anything with three's `userData` bag: Object3D or Material. */
interface HasUserData {
  userData: Record<string, unknown>
}

export const markRole = (o: Object3D, role: Role): void => {
  o.userData.role = role
}
export const roleOf = (o: Object3D): Role | undefined => o.userData.role as Role | undefined

export const markSlot = (m: HasUserData, slot: Slot): void => {
  m.userData.slot = slot
}
export const slotOf = (m: HasUserData): Slot | undefined => m.userData.slot as Slot | undefined

/** A material that is flat colour by design (no map, no procedural surface). */
export const markFlat = (m: HasUserData): void => {
  m.userData.flat = true
}
export const isFlatMaterial = (m: HasUserData): boolean => m.userData.flat === true
