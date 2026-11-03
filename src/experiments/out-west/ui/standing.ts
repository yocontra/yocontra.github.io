/**
 * Your Bounty Hunt standing on the poster panel: the record (wins, losses, draws, streak,
 * cowardice) and the "Let my ghost ride" switch, on by default.
 */

import {
  type DuelStatsResponse,
  fetchDuelSettings,
  fetchDuelStats,
  saveDuelSettings,
} from '../net/api.ts'
import { currentPlayer } from '../net/auth.ts'
import { el } from './sheet.ts'

/** "12–8–1 · 3-win streak (best 5) · 0 cowardice" */
export function recordLine(s: DuelStatsResponse): string {
  const streak = s.streak > 1 ? ` · ${s.streak}-win streak` : ''
  const best = s.bestStreak > 1 ? ` (best ${s.bestStreak})` : ''
  return `${s.wins}–${s.losses}–${s.draws}${streak}${best} · ${s.cowardice} cowardice`
}

export function mountStanding(host: HTMLElement): void {
  if (!currentPlayer()) {
    return
  }
  const box = el('section', 'ow-standing', host)
  el('h3', 'ow-standing-h', box, 'Bounty Hunt')
  const rec = el('p', 'ow-hub-note', box, 'Reading the record…')
  fetchDuelStats()
    .then((r) => {
      rec.textContent = r.ok ? `Record ${recordLine(r.value)}` : 'No duels on the books yet.'
    })
    .catch(() => undefined)
  const label = el('label', 'ow-toggle', box)
  const input = el('input', '', label)
  input.type = 'checkbox'
  input.checked = true
  input.disabled = true
  el('span', '', label, 'Let my ghost ride')
  el(
    'span',
    'ow-toggle-hint',
    label,
    'When nobody’s online, other players can duel a recording of your draw. Your ghost earns you a cut when it wins.',
  )
  fetchDuelSettings()
    .then((r) => {
      if (r.ok) {
        input.checked = !r.value.ghostOptOut
        input.disabled = false
      }
    })
    .catch(() => undefined)
  input.addEventListener('change', () => {
    input.disabled = true
    saveDuelSettings({ ghostOptOut: !input.checked })
      .then((r) => {
        if (r.ok) {
          input.checked = !r.value.ghostOptOut
        } else {
          input.checked = !input.checked
        }
        input.disabled = false
      })
      .catch(() => undefined)
  })
}
