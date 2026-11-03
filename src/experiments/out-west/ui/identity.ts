/**
 * Two sections for "Your poster": changing your gunslinger name ($5,000, once a month, the old
 * name held for you for 30 days) and the players you block (unblock from here).
 */
import type { MeResponse } from '../contract/economy.ts'
import { money } from '../data/economy.ts'
import { changeName, fetchBlocks, setBlocked, unblock } from '../net/social.ts'
import { NAME_CHANGE_PRICE } from '../net/wire-social.ts'
import { button, confirmSheet, el, statusLine } from './sheet.ts'

/** The sign-up rules (api/src/names.ts); the server stays the judge. */
const NAME_MAX = 16
const NAME_OK = /^[\p{L}\p{N} ._'-]+$/u

const SPACES = /\s+/gu
const tidy = (raw: string): string => raw.normalize('NFKC').replace(SPACES, ' ').trim()

/** A sign-up-shaped name check before spending a trip to the server. */
function nameProblem(name: string, current: string): string | null {
  const len = [...name].length
  if (len === 0 || len > NAME_MAX) {
    return `1 to ${NAME_MAX} characters.`
  }
  if (!NAME_OK.test(name)) {
    return "Letters, numbers, spaces and . _ ' - only."
  }
  if (name.toLowerCase() === current.toLowerCase()) {
    return 'That’s already your name.'
  }
  return null
}

export function mountNameChange(
  host: HTMLElement,
  me: MeResponse,
  changed: (patch: Partial<MeResponse>) => void,
): void {
  const box = el('section', 'ow-standing ow-feat-rename', host)
  el('h3', 'ow-standing-h', box, 'A new name')
  el(
    'p',
    'ow-hub-note',
    box,
    `${money(NAME_CHANGE_PRICE)}, once a month. Your old name is held for you for 30 days.`,
  )
  const form = el('form', 'ow-acct-form', box)
  const label = el('label', 'ow-acct-label', form, 'New gunslinger name')
  const input = el('input', 'ow-acct-input', label)
  input.type = 'text'
  input.maxLength = NAME_MAX
  input.setAttribute('autocomplete', 'nickname')
  input.spellcheck = false
  input.value = me.name
  const say = statusLine(box)
  const go = el('button', 'ow-btn ow-btn-primary', form, `Change · ${money(NAME_CHANGE_PRICE)}`)
  go.type = 'submit'
  go.disabled = me.purse < NAME_CHANGE_PRICE
  if (go.disabled) {
    say(`You need ${money(NAME_CHANGE_PRICE - me.purse)} more.`)
  }
  for (const t of ['keydown', 'keyup']) {
    // typing a name never walks, draws or pauses
    input.addEventListener(t, (e) => e.stopPropagation())
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const name = tidy(input.value)
    const problem = nameProblem(name, me.name)
    if (problem) {
      say(problem, 'error')
      return
    }
    const root = host.closest<HTMLElement>('.ow-sheet')?.parentElement ?? document.body
    confirmSheet(root, {
      title: `Ride as ${name}?`,
      body: `${money(NAME_CHANGE_PRICE)} from your purse of ${money(me.purse)}. You can change again in 30 days.`,
      yes: `Change · ${money(NAME_CHANGE_PRICE)}`,
    })
      .then(async (yes) => {
        if (!yes) {
          return
        }
        go.disabled = true
        say('Filing the papers…')
        const r = await changeName(name)
        if (!r.ok) {
          go.disabled = false
          say(r.error, 'error')
          return
        }
        say(`You ride as ${r.value.name} now.`, 'ok')
        changed({ name: r.value.name, purse: r.value.purse })
      })
      .catch(() => undefined)
  })
}

export function mountBlocks(host: HTMLElement): void {
  const box = el('section', 'ow-standing ow-feat-blocks', host)
  el('h3', 'ow-standing-h', box, 'Blocked gunslingers')
  const say = statusLine(box)
  const list = el('ul', 'ow-ledger-list', box)
  const draw = (names: readonly string[]): void => {
    list.replaceChildren()
    say(names.length > 0 ? 'Never matched with you, never shown to you.' : 'Nobody. Peaceful.')
    for (const n of names) {
      const li = el('li', '', list)
      el('span', '', li, n)
      const b = button(li, 'Unblock', () => {
        b.disabled = true
        unblock(n)
          .then((r) => {
            if (r.ok) {
              setBlocked(r.value.blocked)
              draw(r.value.blocked)
            } else {
              b.disabled = false
              say(r.error, 'error')
            }
          })
          .catch(() => undefined)
      })
    }
  }
  say('Reading the list…')
  fetchBlocks()
    .then((r) => (r.ok ? draw(r.value.blocked) : say(r.error, 'error')))
    .catch(() => undefined)
}
