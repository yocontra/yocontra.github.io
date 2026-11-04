/**
 * The licence road's wish (see `duel/licence-road.ts`): the mode a licence gate stopped you at,
 * kept for the tab's session. Tiny on purpose: the saloon loads it before the game.
 */
export type LicensedMode = 'bounty' | 'frontier'

const KEY = 'out-west-after-licence'

export function licenceWish(): LicensedMode | null {
  try {
    const v = sessionStorage.getItem(KEY)
    return v === 'bounty' || v === 'frontier' ? v : null
  } catch {
    return null
  }
}

export function setLicenceWish(m: LicensedMode | null): void {
  try {
    if (m) {
      sessionStorage.setItem(KEY, m)
    } else {
      sessionStorage.removeItem(KEY)
    }
  } catch {
    // private mode: the gate just shows again later
  }
}
