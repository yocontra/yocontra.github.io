/**
 * Pieces of the duel HUD (`hud.ts`): the lose card's receipt and the pause menu's confirm sheet.
 */
import { el } from './sheet.ts'

/** The lose card's receipt: your time and his (either may be missing), and the one-line verdict. */
export interface CardTimes {
  you: number | null
  him: number | null
  note: string
}

/** "YOU 412 ms · HIM 318 ms" and the verdict ("94 ms too slow", "You never drew."); null empties. */
export function renderTimes(box: HTMLElement, t: CardTimes | null): void {
  box.innerHTML = ''
  if (!t) {
    return
  }
  const ms = (v: number) => `${Math.round(v)} ms`
  if (t.you !== null || t.him !== null) {
    const row = el('div', 'ow-card-times-row', box)
    for (const [who, v] of [
      ['You', t.you],
      ['Him', t.him],
    ] as const) {
      const cell = el('div', `ow-card-time ow-card-time-${who.toLowerCase()}`, row)
      el('span', 'ow-card-time-who', cell, who)
      el('span', 'ow-card-time-ms', cell, v === null ? '—' : ms(v))
    }
  }
  el('div', 'ow-card-times-note', box, t.note)
}

interface Choice {
  label: string
  run: () => void
}

export interface ConfirmSpec {
  title: string
  body: string
  yes: Choice
  no: Choice
  /** An optional third way out (e.g. bank the run first). */
  extra?: Choice
}

/** A yes/no sheet drawn into the (open) pause menu; the safe choice has the focus. */
export function renderConfirm(m: HTMLElement, spec: ConfirmSpec): void {
  m.innerHTML = ''
  m.classList.add('on')
  el('h2', 'ow-menu-title', m, spec.title)
  el('p', 'ow-menu-body', m, spec.body)
  const btns = el('div', 'ow-menu-btns', m)
  const button = (cls: string, c: Choice): HTMLButtonElement => {
    const b = el('button', cls, btns, c.label)
    b.type = 'button'
    b.addEventListener('click', c.run)
    return b
  }
  const no = button('ow-btn ow-btn-primary', spec.no)
  if (spec.extra) {
    button('ow-btn', spec.extra)
  }
  button('ow-btn ow-btn-danger', spec.yes)
  no.focus()
}
