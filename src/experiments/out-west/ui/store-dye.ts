/**
 * The Outfitter's dye picker, shown on every piece that takes dye: try any colour on (owned or
 * not), then pay for the dye job once the piece is yours (natural washes it out for free).
 */
import type { CatalogItem } from '../data/catalog.ts'
import { DYES, type DyeId, dyePrice } from '../data/dye.ts'
import { money } from '../data/economy.ts'
import { button, el } from './sheet.ts'

export interface DyePanel {
  item: CatalogItem
  /** The colour it wears now (natural when never dyed or not owned). */
  current: DyeId
  /** The colour being tried on. */
  want: DyeId
  owned: boolean
  /** Your purse, or null signed out. */
  purse: number | null
  busy: boolean
  /** A swatch was tapped: try it on. */
  onTry: (dye: DyeId) => void
  /** Pay for (or wash out to) `want`. */
  onDye: (dye: DyeId, price: number) => void
}

function label(o: DyePanel, name: string, price: number): string {
  if (o.purse === null) {
    return 'Sign in to dye it'
  }
  if (!o.owned) {
    return o.want === 'natural'
      ? 'Buy it first to dye it'
      : `Buy it first · Dye costs ${money(price)}`
  }
  if (o.want === o.current) {
    return o.current === 'natural' ? 'Pick a colour' : `Dyed ${name}`
  }
  if (o.want === 'natural') {
    return 'Remove dye · Free'
  }
  return o.purse < price ? `Need ${money(price - o.purse)} more` : `Dye ${name} · ${money(price)}`
}

export function dyePanel(parent: HTMLElement, o: DyePanel): void {
  const box = el('div', 'ow-feat-dye', parent)
  el('b', 'ow-feat-dye-h', box, o.owned ? 'Dye' : 'Dye · Try a colour')
  const swatches = el('div', 'ow-feat-swatches', box)
  swatches.setAttribute('role', 'radiogroup')
  swatches.setAttribute('aria-label', `Dye for ${o.item.name}`)
  for (const d of DYES) {
    const b = el('button', 'ow-feat-swatch', swatches)
    b.type = 'button'
    b.dataset.dye = d.id
    b.setAttribute('role', 'radio')
    b.setAttribute('aria-checked', String(d.id === o.want))
    b.setAttribute('aria-label', d.name)
    b.title = d.name
    b.classList.toggle('on', d.id === o.want)
    b.classList.toggle('current', o.owned && d.id === o.current)
    if (d.hex) {
      b.style.setProperty('--swatch', d.hex)
    }
  }
  swatches.addEventListener('click', (e) => {
    e.stopPropagation()
    const id =
      e.target instanceof HTMLElement
        ? e.target.closest('[data-dye]')?.getAttribute('data-dye')
        : null
    const dye = DYES.find((d) => d.id === id)?.id
    if (dye) {
      o.onTry(dye)
    }
  })
  const name = DYES.find((d) => d.id === o.want)?.name ?? 'Natural'
  const price = dyePrice(o.item.id, o.want) ?? 0
  if (!o.owned) {
    // the colour is an add-on to the Buy button, not a second purchase of its own
    el(
      'p',
      'ow-hub-note ow-feat-dye-note',
      box,
      o.want === 'natural'
        ? 'Pick a colour. It is added at checkout.'
        : `Added at checkout: +${money(price)}`,
    )
    return
  }
  const go = button(box, label(o, name, price), () => o.onDye(o.want, price))
  go.disabled = o.purse === null || o.want === o.current || o.busy || o.purse < price
}
