/**
 * The Perdition Gazette: a front page between outlaws, the boss epilogue and the credits. The
 * campaign told in the game's plain, dry frontier voice. Pure copy. Owned by the meta-game stream.
 *
 * Page `n` runs before you face outlaw `n` (gauntlet slot, 1..16): the headline is about him, the
 * first line reports the man you just buried, the second says what's coming down the street.
 * Terms follow the copy pass: purse, ledger, poster, licence.
 */

export interface FrontPage {
  /** Issue number, the slot of the outlaw it announces (1-based). */
  issue: number
  headline: string
  lines: readonly [string, string]
}

const p = (issue: number, headline: string, a: string, b: string): FrontPage => ({
  issue,
  headline,
  lines: [a, b],
})

/** Index = gauntlet slot of the outlaw about to be faced. Slot 0 has no page (the intro runs). */
export const FRONT_PAGES: readonly (FrontPage | null)[] = [
  null,
  p(
    2,
    'Talker Arrives, Has Not Stopped Since',
    'Bret Barsh was buried at noon. The undertaker says his hands have finally stopped shaking.',
    'Prescott House rode in at one. He has opinions on your walk and will share all of them.',
  ),
  p(
    3,
    'Man Who Cannot Count Calls You Out',
    'Prescott House talked to the last. The saloon reports a quiet afternoon for the first time in a week.',
    'Calhoun Trine counts his paces aloud and gets them wrong. Mind the crows on the rail.',
  ),
  p(
    4,
    'Drunk Seen Walking, Mostly',
    'Calhoun Trine was put down at ten paces. He had counted eleven.',
    'Burney Coover is three bottles into the morning. He draws when the mood takes him.',
  ),
  p(
    5,
    'Card Sharp Flips For It',
    'Burney Coover lies in the churchyard. The saloon has marked down his tab as a loss.',
    'Ace McConly settles everything with a coin. Do not draw when it lands.',
  ),
  p(
    6,
    'Two Guns, One Delmer',
    'Ace McConly called heads. The coroner has kept the coin.',
    'Delmer Gusselman wears two irons and fires both. The first has never hit anybody.',
  ),
  p(
    7,
    'Impatient Man Will Not Wait For You',
    'Two-Gun Delmer missed twice. The town expected no less.',
    'Salvador Gruell walks short and wants it over. The bell will come early.',
  ),
  p(
    8,
    'Long Walker Brings Weather',
    'Salvador Gruell was buried quick, which he would have wanted.',
    'Felipe Wheeler takes the long walk. The wind comes with him, and the dust hides his hand.',
  ),
  p(
    9,
    'Thorny Rose In Town, No Tells',
    'Felipe Wheeler is buried out past the wash. The wind has dropped.',
    'Laura Bullion stands still and gives nothing away. Watch closely.',
  ),
  p(
    10,
    'Starer Whistles a Dirge',
    'Laura Bullion has gone to her reward. Her poster has been taken down and filed.',
    'Thomas Arnold whistles the whole walk and never looks back. Listen past the tune.',
  ),
  p(
    11,
    'Stage Robber and Gang Ride In',
    'Thomas Arnold stopped whistling at the bell. The street is grateful.',
    'Pearl Hart brings her gang. They heckle. A shout of “DRR” is not the bell.',
  ),
  p(
    12,
    'Gambler Sits Down At the Piano Hall',
    'Pearl Hart was taken in the street. Her gang left town without her and without their horses.',
    'Luke Short plays cards to music. When the piano stops, keep your hand still.',
  ),
  p(
    13,
    'Marshal of El Paso Duels After Dark',
    'Luke Short folded. The piano player has asked for a raise.',
    'Dallas Stoudenmire meets you at night. You can’t see his hand. Listen for the bell.',
  ),
  p(
    14,
    'Fake-Out King Twitches On Main Street',
    'Dallas Stoudenmire was buried by lantern light. El Paso has been informed.',
    'Kid Curry has the twitchiest hands in the territory. Most of what he does is a lie.',
  ),
  p(
    15,
    'Wild Bill Holds Aces and Eights',
    'Kid Curry twitched once too often. The coroner noted it was a real draw this time.',
    'Wild Bill Hickok draws fast and steady. Nobody has beaten him in years.',
  ),
  p(
    16,
    'Curly Bill Posts a Man on the Roof',
    'Wild Bill is dead. The town has hung his cards behind the bar.',
    'Curly Bill Brocius will not duel fair. A rifleman sits on the saloon roof. Watch for the glint.',
  ),
  p(
    17,
    'Hardin Names the Hour: Midnight',
    'Curly Bill and his rifleman are buried side by side. Only one gang remains.',
    'John Wesley Hardin waits under the clock tower. The twelfth strike is the bell.',
  ),
]

/** The front page before outlaw `slot` (0-based), if there is one. */
export const frontPage = (slot: number): FrontPage | null => FRONT_PAGES[slot] ?? null

/** After Hardin: the last front page. */
export const EPILOGUE = {
  issue: 18,
  headline: 'Hardin Dead. Perdition Sleeps.',
  lines: [
    'John Wesley Hardin fell on the twelfth strike. The tower clock is stopped at midnight for good.',
    'The posters have come down off every wall in town. The undertaker has closed early and gone fishing.',
    'Nobody knows much about the stranger who did it. They drank one whiskey and left before sunup.',
  ],
  kicker: 'Special Edition',
} as const

/** The credits roll, in order. */
export const CREDITS: readonly { readonly role: string; readonly name: string }[] = [
  { role: 'A quick-draw western by', name: 'contra' },
  { role: 'Original 2019 game', name: 'out west' },
  { role: 'Outlaws', name: 'Seventeen of the worst' },
  { role: 'Printed by', name: 'The Perdition Gazette' },
  { role: 'Banking', name: 'The Bank of Perdition' },
  { role: 'Undertaking', name: 'Every last one of them' },
  { role: 'Thanks for playing', name: 'Ride again any time' },
]
