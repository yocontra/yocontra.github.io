/**
 * Achievements: eight milestones read from the solo meta-game (medals, the gauntlet, Legend, the
 * Daily Outlaw and signing in). Pure. Owned by the meta-game stream.
 *
 * The ids are stable forever: the Expo app maps them one-to-one onto Game Center and Play Games
 * achievements (`ow.<slug>` → `io.contra.outwest.<slug>` / a Play Games id table), so never rename
 * or reuse one. Add new ones at the end. They pay nothing: no money or XP rides on a client claim.
 */
import { OUTLAW_COUNT, type OutlawMark, tally } from './medals.ts'

export interface AchievementState {
  marks: readonly (OutlawMark | undefined)[]
  /** Outlaws beaten (17-bit mask). */
  clears: number
  legendBest: number
  wins: number
  hats: number
  fakesBeaten: number
  dailyDays: number
  gazette: number
  epilogue: boolean
  signedIn: boolean
  /** One-off moments the duel reported: `lightning`, `stubborn`, `clean-clear`. */
  moments: ReadonlySet<string>
}

export interface Achievement {
  /** Stable id, `ow.<slug>`. */
  readonly id: string
  readonly title: string
  /** How it's earned, one line. */
  readonly line: string
  readonly test: (s: AchievementState) => boolean
}

const BOSS_BIT = 1 << (OUTLAW_COUNT - 1)

const a = (
  slug: string,
  [title, line]: readonly [string, string],
  test: (s: AchievementState) => boolean,
): Achievement => ({ id: `ow.${slug}`, title, line, test })

export const ACHIEVEMENTS: readonly Achievement[] = [
  a('first-blood', ['First Blood', 'Win your first duel.'], (s) => s.wins >= 1),
  a('first-medal', ['Pinned', 'Win a medal.'], (s) => tally(s.marks).bronze >= 1),
  a('first-gold', ['Struck Gold', 'Win a gold medal.'], (s) => tally(s.marks).gold >= 1),
  a(
    'gauntlet',
    ['Last Man Standing', 'Kill John Wesley Hardin.'],
    (s) => (s.clears & BOSS_BIT) !== 0,
  ),
  a('lightning', ['Greased Lightning', 'Win a duel under 180 ms.'], (s) =>
    s.moments.has('lightning'),
  ),
  a('legend-6', ['Legend', 'Beat 6 outlaws in one Legend run.'], (s) => s.legendBest >= 6),
  a('daily-first', ['Daily Bread', 'Win the Daily Outlaw.'], (s) => s.dailyDays >= 1),
  a('signed', ['On the Books', 'Sign in with a passkey.'], (s) => s.signedIn),
]

/** Achievements `s` meets that aren't in `have` yet. */
export function newlyEarned(
  s: AchievementState,
  have: Readonly<Record<string, number>>,
): Achievement[] {
  return ACHIEVEMENTS.filter((x) => have[x.id] === undefined && x.test(s))
}
