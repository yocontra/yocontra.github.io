// biome-ignore-all lint/performance/noBarrelFile: the scene and the sim share these porch helpers
/**
 * Every cover kind Perdition dresses: what stands there and how tall it is. `dressing.ts` builds
 * each kind to fill its collider rect exactly, and `tools/town-audit.ts` flags any cover whose kind
 * isn't here (an invisible wall) and any low cover that should carry a `vaultHeight` but doesn't.
 * No DOM, so the audit and the client's surface lookups can import it. Also the porch and deck
 * geometry the scene and the footstep lookup share.
 */
export interface CoverVisual {
  /** What stands there (the map legend, the audit). */
  what: string
  /** Height of the visual's top, m. */
  height: number
  /** Whether a rider can vault it (its layout entries then carry `vaultHeight`). */
  vault: boolean
  /** What a bullet that stops on it hits. */
  surface: 'wood' | 'metal'
}

export const COVER_VISUALS: Record<string, CoverVisual> = {
  barrels: { what: 'barrels', height: 0.95, vault: true, surface: 'wood' },
  crates: { what: 'crates', height: 0.75, vault: true, surface: 'wood' },
  crate_stack: { what: 'crates stacked high', height: 2.2, vault: false, surface: 'wood' },
  hay: { what: 'hay bales', height: 1.0, vault: true, surface: 'wood' },
  fence: { what: 'split-rail fence', height: 1.1, vault: true, surface: 'wood' },
  trough: { what: 'water trough', height: 0.7, vault: true, surface: 'wood' },
  hitch_rail: { what: 'hitching rail', height: 1.05, vault: true, surface: 'wood' },
  wagon: { what: 'farm wagon', height: 1.1, vault: true, surface: 'wood' },
  covered_wagon: { what: 'covered freight wagon', height: 3.0, vault: false, surface: 'wood' },
  freight_wagon: {
    what: 'freight wagon loaded with crates',
    height: 2.2,
    vault: false,
    surface: 'wood',
  },
  stagecoach: { what: 'stagecoach', height: 2.6, vault: false, surface: 'wood' },
  wreck: { what: 'stagecoach on its side', height: 2.1, vault: false, surface: 'wood' },
  lumber: { what: 'stacked lumber', height: 1.0, vault: true, surface: 'wood' },
  woodpile: { what: 'split firewood', height: 1.0, vault: true, surface: 'wood' },
  well: { what: 'roofed well', height: 2.6, vault: false, surface: 'wood' },
  post: { what: 'boardwalk post', height: 3.1, vault: false, surface: 'wood' },
  pole: { what: 'telegraph pole', height: 7, vault: false, surface: 'wood' },
  boxcar: { what: 'railroad boxcar', height: 3.8, vault: false, surface: 'metal' },
  buffer: { what: 'track buffer stop', height: 1.0, vault: true, surface: 'wood' },
  headstone: { what: 'headstone', height: 0.8, vault: true, surface: 'metal' },
  counter: { what: 'counter', height: 1.1, vault: true, surface: 'wood' },
  table: { what: 'table and chairs', height: 0.8, vault: true, surface: 'wood' },
  forge: { what: 'brick forge', height: 1.0, vault: false, surface: 'metal' },
  anvil: { what: 'anvil on a stump', height: 0.8, vault: true, surface: 'metal' },
  bench: { what: 'bench', height: 0.5, vault: true, surface: 'wood' },
  coffins: { what: 'coffins', height: 0.9, vault: true, surface: 'wood' },
  piano: { what: 'upright piano', height: 1.35, vault: false, surface: 'wood' },
  shelves: { what: 'wall shelving with goods', height: 2.3, vault: false, surface: 'wood' },
  stairs: { what: 'staircase to the upper floor', height: 3.3, vault: false, surface: 'wood' },
  safe: { what: 'iron safe', height: 1.5, vault: false, surface: 'metal' },
  stove: { what: 'pot-bellied stove', height: 1.1, vault: false, surface: 'metal' },
  workbench: { what: 'workbench', height: 0.95, vault: true, surface: 'wood' },
  barrel_rack: { what: 'barrel rack', height: 1.3, vault: false, surface: 'wood' },
  bed: { what: 'cot', height: 0.6, vault: true, surface: 'wood' },
  bars: { what: 'cell bars', height: 2.6, vault: false, surface: 'metal' },
  bridge_rail: { what: 'bridge rail', height: 1.0, vault: true, surface: 'wood' },
}

/**
 * Buildings with a boardwalk porch along their street front (the scene and footsteps share it).
 * The sim owns the geometry now (`sim/porches.ts`); re-exported here for the scene's callers.
 */
export {
  decks,
  FLOOR_TOP,
  floorHeight,
  frontOf,
  PLATFORM_DEPTH,
  PORCH_DECK,
  PORCH_DEPTH,
  PORCH_ROOF,
  PORCHED,
  sideStrip,
  UPPER_FLOOR,
  UPPER_FLOOR_T,
} from '../sim/porches.ts'
