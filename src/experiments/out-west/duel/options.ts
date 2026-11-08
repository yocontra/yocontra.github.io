import type { Poster } from '../contract/duel.ts'
import type { DailySpec } from '../data/daily.ts'
import type { RankedSession } from '../net/ranked.ts'
import type { Verdict } from './clock.ts'

export type HubShot = 'hub' | 'store'
export interface DailyOpts {
  spec: DailySpec
  session: RankedSession
  onExit: (verdict: Verdict | null, drewMs: number | null) => void
}
export interface PvpOpts {
  wsUrl: string
  opponent: Poster
  xpBefore: number | null
  purse: number | null
  refreshXp: () => Promise<number | null>
  onExit: (how: 'saloon' | 'next') => void
}
