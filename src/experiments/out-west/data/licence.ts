/**
 * The Bounty Hunt licence: beat the first three gauntlet outlaws on a ranked run while signed in
 * (bits 0–2 of `profiles.gauntlet_clears`). Pure and shared: the matchmaker enforces it, the account
 * panel shows it.
 */

/** How many outlaws, from the first, the licence takes. */
export const LICENCE_OUTLAWS = 3
export const LICENCE_MASK = (1 << LICENCE_OUTLAWS) - 1

export interface LicenceStatus {
  licensed: boolean
  /** Licence outlaws cleared so far (0..3). */
  cleared: number
  /** Licence outlaws still to clear. */
  remaining: number
}

export function licenceStatus(gauntletClears: number): LicenceStatus {
  let cleared = 0
  for (let i = 0; i < LICENCE_OUTLAWS; i++) {
    if ((gauntletClears & (1 << i)) !== 0) {
      cleared++
    }
  }
  return {
    licensed: (gauntletClears & LICENCE_MASK) === LICENCE_MASK,
    cleared,
    remaining: LICENCE_OUTLAWS - cleared,
  }
}

/** The account plate's two lines: a kicker above the name, and the progress (null once licensed). */
export function licenceCopy(status: LicenceStatus): { kicker: string; progress: string | null } {
  if (status.licensed) {
    return { kicker: 'Licensed gunslinger', progress: null }
  }
  const n = status.remaining
  return {
    kicker: 'Unlicensed gunslinger',
    progress: `Beat ${n} more outlaw${n === 1 ? '' : 's'} on a ranked run to earn your licence`,
  }
}
