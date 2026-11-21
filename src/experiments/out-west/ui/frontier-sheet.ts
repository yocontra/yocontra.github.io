/**
 * The hub's Frontier sheet: two towns. The practice town (up to four bots, in the browser, no account and
 * no money at stake) is open to everyone, guests included; the live town wants a passkey and the
 * licence (spec §2), which the hub checks when `live` is chosen.
 */
import { button, el, panelSheet } from './sheet.ts'

export const PRACTICE_TOWN_URL = '/experiments/out-west/frontier/?server=loopback'

export function frontierSheet(parent: HTMLElement, signedIn: boolean, live: () => void): void {
  const s = panelSheet(parent, { title: 'Frontier', cls: 'ow-feat-gate' })
  el(
    'p',
    'ow-hub-note',
    s.body,
    'Free-for-all in Perdition. Shoot riders, collect their money, and bank it before you die.',
  )
  const row = el('div', 'ow-hub-row', s.body)
  const practice = () =>
    button(
      row,
      'Practice town',
      () => {
        s.close()
        location.assign(PRACTICE_TOWN_URL)
      },
      !signedIn,
    )
  if (!signedIn) {
    practice()
  }
  button(
    row,
    signedIn ? 'Live town' : 'Sign in for live town',
    () => {
      s.close()
      live()
    },
    signedIn,
  )
  if (signedIn) {
    practice()
  }
  el(
    'p',
    'ow-hub-note',
    s.body,
    'Practice against up to four bots. Live play requires a licence and uses your online purse.',
  )
}
