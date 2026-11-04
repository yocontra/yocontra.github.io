/**
 * The achievements sheet (meta-game stream): all twenty, earned ones stamped with the day, the
 * rest greyed with how to get them. The toast that announces each lives in `ui/toast.ts`.
 */
import { ACHIEVEMENTS } from '../data/achievements.ts'
import type { Meta } from '../meta/progress.ts'
import { el, panelSheet } from './sheet.ts'

export function openAchievements(root: HTMLElement, meta: Meta): void {
  const s = panelSheet(root, { title: 'Achievements', paper: true, cls: 'ow-ach' })
  const have = meta.data.achievements
  const n = ACHIEVEMENTS.filter((a) => have[a.id] !== undefined).length
  el('div', 'ow-results-kicker', s.body, `${n} of ${ACHIEVEMENTS.length} earned`)
  const list = el('ul', 'ow-ach-list', s.body)
  for (const a of ACHIEVEMENTS) {
    const at = have[a.id]
    const li = el('li', at === undefined ? 'locked' : 'earned', list)
    li.dataset.id = a.id
    el('span', 'ow-ach-seal', li).setAttribute('aria-hidden', 'true')
    const text = el('span', 'ow-ach-text', li)
    el('b', 'ow-ach-title', text, a.title)
    el('span', 'ow-ach-line', text, a.line)
    el('time', 'ow-t-num', li, at === undefined ? '' : new Date(at).toLocaleDateString())
  }
}
