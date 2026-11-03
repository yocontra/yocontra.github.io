/**
 * Inside the Last Chance Saloon: the chalkboard of who stood the house a round, and "Buy the house
 * a round" ($1,000, your name on the board), plus "Ride Again" (prestige) once you reach level 50.
 * Both spend through an in-game confirmation sheet, never `confirm()`.
 */
import type { MeResponse } from '../contract/economy.ts'
import type { ChalkboardLine } from '../contract/social.ts'
import { money } from '../data/economy.ts'
import {
  baseBounty,
  canPrestige,
  effectiveLevel,
  MAX_LEVEL,
  MAX_PRESTIGE,
} from '../data/progression.ts'
import { HOUSE_ROUND_PRICE } from '../data/sinks.ts'
import { currentPlayer } from '../net/auth.ts'
import { blockedNames, buyRound, fetchChalkboard, prestige } from '../net/social.ts'
import { uiSound } from './sfx.ts'
import { button, confirmSheet, el, panelSheet, statusLine } from './sheet.ts'

const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

function chalk(
  list: HTMLElement,
  rounds: readonly ChalkboardLine[],
  hide: ReadonlySet<string>,
): void {
  list.replaceChildren()
  const shown = rounds.filter((r) => !hide.has(r.name.toLowerCase()))
  if (shown.length === 0) {
    el('li', '', list, 'Nobody’s stood a round yet. The barkeep is waiting.')
    return
  }
  for (const r of shown) {
    const li = el('li', '', list)
    el('span', 'ow-feat-chalk-name', li, r.name)
    el('time', '', li, when.format(new Date(r.at)))
  }
}

export interface SaloonDeps {
  me: () => MeResponse | null
  changed: (patch: Partial<MeResponse>) => void
}

/** The chalkboard sheet, with the round to buy when signed in. */
export function openSaloon(root: HTMLElement, deps: SaloonDeps): void {
  const sheet = panelSheet(root, { title: 'The chalkboard', cls: 'ow-feat-saloon' })
  el(
    'p',
    'ow-hub-note',
    sheet.body,
    `Stand the whole saloon a round for ${money(HOUSE_ROUND_PRICE)} and your name goes up in chalk.`,
  )
  const board = el('ol', 'ow-ledger-list ow-feat-chalk', sheet.body)
  const say = statusLine(sheet.body)
  say('Reading the chalk…')
  let hide: ReadonlySet<string> = new Set()
  Promise.all([fetchChalkboard(), currentPlayer() ? blockedNames() : new Set<string>()])
    .then(([r, blocked]) => {
      hide = blocked
      if (!r.ok) {
        say(r.error, 'error')
        return
      }
      say('')
      chalk(board, r.value.rounds, hide)
    })
    .catch(() => undefined)
  const me = deps.me()
  if (!me) {
    el('p', 'ow-hub-note', sheet.body, 'Sign in with a passkey to buy a round.')
    return
  }
  const row = el('div', 'ow-hub-row', sheet.body)
  const buy = button(
    row,
    `Buy the house a round · ${money(HOUSE_ROUND_PRICE)}`,
    () => {
      const now = deps.me()
      if (!now) {
        return
      }
      confirmSheet(root, {
        title: 'Buy the house a round?',
        body: `${money(HOUSE_ROUND_PRICE)} from your purse of ${money(now.purse)}. Your name goes on the chalkboard. Nothing else changes.`,
        yes: `Pour · ${money(HOUSE_ROUND_PRICE)}`,
      })
        .then(async (yes) => {
          if (!yes) {
            return
          }
          buy.disabled = true
          say('Pouring…')
          const r = await buyRound()
          if (!r.ok) {
            buy.disabled = false
            say(r.error, 'error')
            return
          }
          uiSound('uiBuy')
          deps.changed({ purse: r.value.purse })
          chalk(board, r.value.rounds, hide)
          say('The house drinks to you.', 'ok')
          buy.disabled = r.value.purse < HOUSE_ROUND_PRICE
        })
        .catch(() => undefined)
    },
    true,
  )
  buy.disabled = me.purse < HOUSE_ROUND_PRICE
  if (buy.disabled) {
    say(`You need ${money(HOUSE_ROUND_PRICE - me.purse)} more for a round.`)
  }
}

/**
 * "Ride Again" at level 50: back to level 1 with a star (up to five), keeping the wallet, kit and
 * titles; your bounty is multiplied by 1 + 0.2 per star. Confirmed on a sheet, then the server
 * returns the new profile.
 */
export function rideAgain(
  root: HTMLElement,
  me: MeResponse,
  done: (next: MeResponse) => void,
): void {
  if (!canPrestige(me.level, me.prestige)) {
    return
  }
  const next = me.prestige + 1
  confirmSheet(root, {
    title: 'Ride again?',
    body: `You go back to level 1 with star ${next} of ${MAX_PRESTIGE}. You keep your purse (${money(me.purse)}), every piece of kit and your titles. Your bounty grows: ${money(baseBounty(1, next))} at level 1, ${money(baseBounty(MAX_LEVEL, next))} at ${MAX_LEVEL}. Bounty Hunt matches you as level ${effectiveLevel(1, next)}.`,
    yes: `Ride again · ★${next}`,
  })
    .then(async (yes) => {
      if (!yes) {
        return
      }
      const r = await prestige()
      if (!r.ok) {
        const s = panelSheet(root, { title: 'Ride again' })
        el('p', 'ow-hub-note', s.body, r.error)
        return
      }
      uiSound('levelUp')
      done(r.value)
    })
    .catch(() => undefined)
}
