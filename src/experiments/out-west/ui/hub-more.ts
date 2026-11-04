/**
 * The saloon's quieter doors, so the street stays clear: Account and Settings as two small icon
 * buttons by your plate, and everything that isn't a mode (the Gauntlet map, achievements, the
 * chalkboard, the ledger) in one "More" sheet. The leaderboard keeps its own button.
 */
import { cog, icon } from './icons.ts'
import { button, el, panelSheet } from './sheet.ts'

export interface HubLink {
  label: string
  open: () => void
}

/** Account (the bank, where your account is) and Settings (the cog): 48 px icons by the plate. */
export function hubTools(parent: HTMLElement, o: { account: () => void; settings: () => void }) {
  const row = el('div', 'ow-hub-tools', parent)
  const tool = (label: string, art: SVGSVGElement, run: () => void): void => {
    const b = el('button', 'ow-hub-tool', row)
    b.type = 'button'
    b.setAttribute('aria-label', label)
    b.title = label
    b.append(art)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      run()
    })
  }
  tool('Account', icon('bank'), o.account)
  tool('Settings', cog(), o.settings)
  return row
}

/** The More sheet: one button per door; picking one closes this sheet and opens that one. */
export function openMore(root: HTMLElement, links: readonly HubLink[]): void {
  const s = panelSheet(root, { title: 'More', cls: 'ow-hub-more' })
  const list = el('div', 'ow-hub-more-list', s.body)
  for (const l of links) {
    button(list, l.label, () => {
      s.close()
      l.open()
    })
  }
}
