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
import { button } from './sheet.ts'

export interface HubMeta {
  /** Adds the tile and links to the hub's side column; returns its refresher. */
  mount: (side: HTMLElement, links: HTMLElement) => { refresh: () => void }
  /** The strip's line for a guest ("Guest · purse $120 · 340 XP"), or null to keep the default. */
  guestLine: () => string | null
}

export function hubMeta(root: HTMLElement, meta: Meta, daily: DailyDeps): HubMeta {
  return {
    mount: (side, links) => {
      const tile = new DailyTile(root, side, daily)
      // the day's tile sits over the four mode tiles
      side.prepend(tile.button)
      const openAch = (): void => openAchievements(root, meta)
      const map = button(links, 'Gauntlet map', () =>
        openGauntletMap(root, meta, {
          gazette: () => openBackIssues(root, meta),
          achievements: openAch,
        }),
      )
      links.prepend(map)
      button(links, 'Achievements', openAch)
      tile.refresh().catch(() => undefined)
      return {
        refresh: () => {
          tile.refresh().catch(() => undefined)
        },
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
