/**
 * The licence road: a player stopped at Bounty Hunt's or Frontier's licence gate who chose "Ride
 * the ranked gauntlet" wanted that mode, not the gauntlet. The wish is kept for the tab's session;
 * once the third outlaw falls on that ranked run the duel offers the way back, and the saloon
 * carries on into the mode as soon as the server shows the licence.
 */
import { LICENCE_OUTLAWS } from '../data/licence.ts'
import { type LicensedMode, licenceWish, setLicenceWish } from '../meta/licence-wish.ts'
import { confirmSheet } from '../ui/sheet.ts'
import type { Director } from './director.ts'
import { toSaloon } from './mode.ts'

const MODE_NAME: Readonly<Record<LicensedMode, string>> = {
  bounty: 'Bounty Hunt',
  frontier: 'Frontier',
}

/**
 * Before outlaw 4 of a ranked run, with a wish on the road: offer the mode now. Returns null when
 * there is nothing to offer (the gauntlet carries on); otherwise a promise of whether the player
 * left for the saloon (which then carries on into the mode).
 */
export function offerLicensedMode(d: Director, next: number): Promise<boolean> | null {
  const wish = licenceWish()
  if (!(wish && d.ranked && next === LICENCE_OUTLAWS && d.onSaloon)) {
    return null
  }
  return confirmSheet(d.c.hud.root, {
    title: 'Licence earned',
    body: `You’ve beaten the first ${LICENCE_OUTLAWS} outlaws. Go to ${MODE_NAME[wish]} now (this ranked run ends), or keep riding.`,
    yes: MODE_NAME[wish],
    no: 'Keep riding',
    focusNo: true,
  }).then((go) => {
    if (go) {
      toSaloon(d)
    } else {
      // the wish is spent: the player chose the gauntlet
      setLicenceWish(null)
    }
    return go
  })
}
