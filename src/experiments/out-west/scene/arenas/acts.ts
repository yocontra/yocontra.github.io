/**
 * The campaign travels: which arena each outlaw is fought in, by his slot in the gauntlet. The
 * lighting already runs noon to midnight across the slots (`Outlaw.day`), and each arena was built
 * for the light its act is fought in:
 *
 * - Act I, outlaws 1–6 (noon to afternoon): the main street.
 * - Act II, outlaws 7–10 (afternoon to golden hour): the rail depot, its platform and water tower.
 * - Act III, outlaws 11–13 (sunset to dusk): the mission courtyard, adobe under the bell gable.
 * - Act IV, outlaws 14–15 (night): the bank square, brick fronts and gas lamps.
 * - The finale, outlaws 16–17: home to the main street (the rifleman on the saloon roof, Hardin
 *   under the clock tower at midnight).
 *
 * Bounty Hunt and the hub stay on the street; the Daily Outlaw is fought where his slot is.
 */
import type { ArenaId } from './types.ts'

const BY_SLOT: readonly ArenaId[] = [
  'street',
  'street',
  'street',
  'street',
  'street',
  'street',
  'depot',
  'depot',
  'depot',
  'depot',
  'mission',
  'mission',
  'mission',
  'bank',
  'bank',
  'street',
  'street',
]

/** The arena outlaw `slot` (0-based) is fought in. */
export function arenaForSlot(slot: number): ArenaId {
  return BY_SLOT[slot] ?? 'street'
}
