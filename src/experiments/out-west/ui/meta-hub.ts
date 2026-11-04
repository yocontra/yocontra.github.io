/**
 * The meta-game's pieces of the saloon (meta-game stream): the Daily Outlaw tile over the mode
 * tiles, the Gauntlet map and Achievements links, and the guest purse line on the poster strip.
 * `ui/hub.ts` calls `mount` once and `refresh` whenever it reloads your profile.
 */
import { money } from '../data/economy.ts'
import type { Meta } from '../meta/progress.ts'
import { currentPlayer } from '../net/auth.ts'
import { openAchievements } from './achievements.ts'
import { type DailyDeps, DailyTile } from './daily.ts'
import { openGauntletMap } from './gauntlet-map.ts'
import { openBackIssues } from './gazette.ts'

/** What the hub gets back from `mount`: the tile's refresher and the ways into the meta sheets. */
export interface HubMetaUi {
  refresh: () => void
  /** The Gauntlet map (from the Quick Draw sheet and the saloon's More sheet). */
  map: () => void
  achievements: () => void
}

export interface HubMeta {
  /** Puts the Daily Outlaw banner over the hub's mode tiles; the hub places the links itself. */
  mount: (side: HTMLElement) => HubMetaUi
  /** The strip's line for a guest ("Guest · purse $120 · 340 XP"), or null to keep the default. */
  guestLine: () => string | null
}

export function hubMeta(root: HTMLElement, meta: Meta, daily: DailyDeps): HubMeta {
  return {
    mount: (side) => {
      const tile = new DailyTile(root, side, daily)
      // the day's banner sits over the four mode tiles
      side.prepend(tile.button)
      const achievements = (): void => openAchievements(root, meta)
      const map = (): void =>
        openGauntletMap(root, meta, {
          gazette: () => openBackIssues(root, meta),
          achievements,
        })
      tile.refresh().catch(() => undefined)
      return {
        refresh: () => {
          tile.refresh().catch(() => undefined)
        },
        map,
        achievements,
      }
    },
    guestLine: () => {
      if (currentPlayer()) {
        return null
      }
      const p = meta.guestPurse()
      return p.xp > 0 || p.cash > 0
        ? `Guest · purse ${money(p.cash)} · ${p.xp.toLocaleString('en-US')} XP`
        : null
    },
  }
}
