/**
 * Your Bounty Hunt standing on the poster panel: the record (wins, losses, draws, streak,
 * cowardice) and the ghost switch, on by default.
 */
import type { DuelStatsResponse } from '../contract/duel.ts'
import { fetchDuelSettings, fetchDuelStats, saveDuelSettings } from '../net/api.ts'
import { currentPlayer } from '../net/auth.ts'
import { el } from './sheet.ts'

/** "12 W · 8 L · 1 T · 3-win streak (best 5) · Early draws: 0" */
export function recordLine(s: DuelStatsResponse): string {
  const streak = s.streak > 1 ? ` · ${s.streak}-win streak` : ''
  const best = s.bestStreak > 1 ? ` (best ${s.bestStreak})` : ''
  return `${s.wins} W · ${s.losses} L · ${s.draws} T${streak}${best} · Early draws: ${s.cowardice}`
}

export function mountStanding(host: HTMLElement): void {
  if (!currentPlayer()) {
    return
  }
  const box = el('section', 'ow-standing', host)
  el('h3', 'ow-standing-h', box, 'Bounty Hunt')
  const rec = el('p', 'ow-hub-note', box, 'Loading…')
  fetchDuelStats()
    .then((r) => {
      rec.textContent = r.ok ? `Record ${recordLine(r.value)}` : 'No duels yet.'
    })
    .catch(() => undefined)
  const label = el('label', 'ow-toggle', box)
  const input = el('input', '', label)
  input.type = 'checkbox'
  input.checked = true
  input.disabled = true
  el('span', '', label, 'Let others duel my ghost')
  el(
    'span',
    'ow-toggle-hint',
    label,
    'When no one is online, players can duel a recording of you. You earn money when your ghost wins.',
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
