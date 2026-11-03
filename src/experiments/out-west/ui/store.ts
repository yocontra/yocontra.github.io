/**
 * The Outfitter: browse the catalog by slot, see rarity and level gates, try anything on your own
 * character (the street stays live behind the panel), buy with a confirmation sheet, and equip.
 * Cosmetic only; the server is the authority on price, gates and ownership.
 */
import type { MeResponse } from '../contract/economy.ts'
import {
  CATALOG,
  type CatalogItem,
  canBuy,
  DEFAULT_LOADOUT,
  type ItemId,
  type Loadout,
  normalizeLoadout,
  type Slot,
  STARTER_ITEMS,
} from '../data/catalog.ts'
import { DYES, type DyeId, type Dyes, dyePrice, isDyeable } from '../data/dye.ts'
import { money } from '../data/economy.ts'
import { buyItem, fetchStore, saveLoadout } from '../net/api.ts'
import { dyeItem } from '../net/social.ts'
import { type IconName, icon } from './icons.ts'
import { uiSound } from './sfx.ts'
import { button, confirmSheet, el, swallow } from './sheet.ts'

const SLOT_TABS: readonly { slot: Slot; label: string }[] = [
  { slot: 'hat', label: 'Hats' },
  { slot: 'gun', label: 'Irons' },
  { slot: 'outfit', label: 'Outfits' },
  { slot: 'extra', label: 'Extras' },
  { slot: 'spurs', label: 'Spurs' },
  { slot: 'holster', label: 'Holsters' },
  { slot: 'frame', label: 'Frames' },
  { slot: 'drawSound', label: 'Draw sounds' },
  { slot: 'saddlebag', label: 'Saddlebags' },
]

const SLOT_ICON: Record<Slot, IconName> = {
  hat: 'hat',
  gun: 'revolver',
  outfit: 'coat',
  extra: 'badge',
  spurs: 'spurs',
  holster: 'holster',
  frame: 'bounty',
  drawSound: 'dynamite',
  saddlebag: 'money',
}

const RARITY_LABEL: Record<CatalogItem['rarity'], string> = {
  starter: 'Starter',
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  legendary: 'Legendary',
  reward: 'Reward',
}

/** Where a piece of kit shows (the ones you can't see on the street say so). */
const SLOT_NOTE: Partial<Record<Slot, string>> = {
  frame: 'Frames your poster in Bounty Hunt.',
  drawSound: 'Plays on your shot in Bounty Hunt. Never before it.',
  saddlebag: 'The bag you drop in Frontier.',
  holster: 'Tooling shows up close. Same draw for everyone.',
}

export interface StoreDeps {
  me: () => MeResponse | null
  /** Dress your character in this loadout (preview or equipped), with these dyes (yours if omitted). */
  preview: (l: Loadout, dyes?: Dyes) => void
  /** The server accepted a purchase, a dye job or a new loadout. */
  changed: (patch: Partial<MeResponse>) => void
  close: () => void
}

export class Outfitter {
  private readonly root: HTMLElement
  private readonly list: HTMLElement
  private readonly purseEl: HTMLElement
  private readonly detail: HTMLElement
  private readonly tabs = new Map<Slot, HTMLButtonElement>()
  private readonly deps: StoreDeps
  private items: readonly CatalogItem[] = CATALOG
  private owned = new Set<string>(STARTER_ITEMS)
  private slot: Slot = 'hat'
  private picked: CatalogItem | null = null
  /** A dye being tried on the picked item (not bought yet). */
  private tryDye: DyeId | null = null
  private busy = false as boolean

  constructor(parent: HTMLElement, deps: StoreDeps) {
    this.deps = deps
    this.root = el('div', 'ow-store', parent)
    this.root.setAttribute('role', 'dialog')
    this.root.setAttribute('aria-label', 'The Outfitter')
    swallow(this.root)
    const head = el('div', 'ow-store-head', this.root)
    el('h2', 'ow-hub-h', head, 'Outfitter')
    this.purseEl = el('div', 'ow-store-purse', head)
    button(head, 'Done', () => this.close())
    const tabs = el('div', 'ow-store-tabs', this.root)
    tabs.setAttribute('role', 'tablist')
    for (const t of SLOT_TABS) {
      const b = el('button', 'ow-store-tab', tabs)
      b.type = 'button'
      b.append(icon(SLOT_ICON[t.slot]), t.label)
      b.setAttribute('role', 'tab')
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        this.show(t.slot)
      })
      this.tabs.set(t.slot, b)
    }
    this.list = el('div', 'ow-store-list', this.root)
    this.detail = el('div', 'ow-store-detail', this.root)
    const me = deps.me()
    if (me) {
      this.owned = new Set(me.owned)
    }
    this.show('hat')
    requestAnimationFrame(() => this.root.classList.add('on'))
    this.load().catch(() => undefined)
  }

  private async load(): Promise<void> {
    const r = await fetchStore()
    if (!r.ok) {
      return
    }
    if (r.value.items.length > 0) {
      this.items = r.value.items
    }
    if (this.deps.me()) {
      this.owned = new Set(r.value.owned)
    }
    this.show(this.slot)
  }

  private get equipped(): Loadout {
    return normalizeLoadout(this.deps.me()?.loadout ?? DEFAULT_LOADOUT)
  }

  private show(slot: Slot): void {
    this.slot = slot
    for (const [s, b] of this.tabs) {
      b.classList.toggle('on', s === slot)
      b.setAttribute('aria-selected', String(s === slot))
    }
    const me = this.deps.me()
    this.purseEl.replaceChildren()
    this.purseEl.classList.toggle('guest', !me)
    if (me) {
      this.purseEl.append(icon('money'), `${money(me.purse)} · Lv ${me.level}`)
    } else {
      this.purseEl.textContent = 'Signed out · try on only'
    }
    this.list.replaceChildren()
    const eq = this.equipped
    for (const item of this.items.filter((i) => i.slot === slot)) {
      this.card(item, eq)
    }
    if (slot === 'extra') {
      this.noneCard(eq)
    }
    this.renderDetail()
  }

  private card(item: CatalogItem, eq: Loadout): void {
    const me = this.deps.me()
    const b = el('button', `ow-item r-${item.rarity}`, this.list)
    b.type = 'button'
    b.classList.toggle('picked', this.picked?.id === item.id)
    b.append(icon(SLOT_ICON[item.slot]))
    el('span', 'ow-item-rarity', b, RARITY_LABEL[item.rarity])
    el('span', 'ow-item-name', b, item.name)
    let tag: string
    if (eq[item.slot] === item.id) {
      tag = 'Equipped'
    } else if (this.owned.has(item.id)) {
      tag = 'Owned'
    } else if (item.source === 'reward') {
      tag = item.unlock ?? 'Earned'
    } else if (me && me.level < item.level) {
      tag = `Lv ${item.level}`
      b.classList.add('locked')
    } else {
      tag = item.price > 0 ? money(item.price) : 'Free'
    }
    el('span', 'ow-item-tag', b, tag)
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      this.pick(item)
    })
  }

  private noneCard(eq: Loadout): void {
    const b = el('button', 'ow-item r-starter', this.list)
    b.type = 'button'
    el('span', 'ow-item-rarity', b, 'Bare')
    el('span', 'ow-item-name', b, 'Nothing extra')
    el('span', 'ow-item-tag', b, eq.extra === null ? 'Equipped' : '')
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      this.picked = null
      this.deps.preview({ ...this.equipped, extra: null })
      this.equip({ ...this.equipped, extra: null }).catch(() => undefined)
    })
  }

  private get dyes(): Dyes {
    return this.deps.me()?.dyes ?? {}
  }

  private pick(item: CatalogItem): void {
    this.picked = item
    this.tryDye = null
    this.deps.preview({ ...this.equipped, [item.slot]: item.id })
    this.show(this.slot)
  }

  private renderDetail(): void {
    this.detail.replaceChildren()
    const item = this.picked
    if (!item || item.slot !== this.slot) {
      el('p', 'ow-hub-note', this.detail, SLOT_NOTE[this.slot] ?? 'Tap a piece to try it on.')
      return
    }
    el('b', 'ow-store-name', this.detail, item.name)
    el(
      'p',
      'ow-hub-note',
      this.detail,
      `${RARITY_LABEL[item.rarity]} · ${item.level > 1 ? `Level ${item.level}` : 'Any level'}${
        SLOT_NOTE[item.slot] ? ` · ${SLOT_NOTE[item.slot]}` : ''
      }`,
    )
    const me = this.deps.me()
    if (this.owned.has(item.id)) {
      const on = this.equipped[item.slot] === item.id
      const b = button(
        this.detail,
        on ? 'Equipped' : 'Equip',
        () => {
          this.equip({ ...this.equipped, [item.slot]: item.id }).catch(() => undefined)
        },
        true,
      )
      b.disabled = on || !me
      if (me && isDyeable(item)) {
        this.dyeSection(item)
      }
      return
    }
    this.buyButton(item, me)
  }

  /** Dye jobs: try a colour on, then pay for it (natural washes it out for free). */
  private dyeSection(item: CatalogItem): void {
    const box = el('div', 'ow-feat-dye', this.detail)
    const current: DyeId = this.dyes[item.id as ItemId] ?? 'natural'
    const want = this.tryDye ?? current
    el('b', 'ow-feat-dye-h', box, 'Dye job')
    const swatches = el('div', 'ow-feat-swatches', box)
    swatches.setAttribute('role', 'radiogroup')
    swatches.setAttribute('aria-label', `Dye for ${item.name}`)
    for (const d of DYES) {
      const b = el('button', 'ow-feat-swatch', swatches)
      b.type = 'button'
      b.dataset.dye = d.id
      b.setAttribute('role', 'radio')
      b.setAttribute('aria-checked', String(d.id === want))
      b.setAttribute('aria-label', d.name)
      b.title = d.name
      b.classList.toggle('on', d.id === want)
      b.classList.toggle('current', d.id === current)
      if (d.hex) {
        b.style.setProperty('--swatch', d.hex)
      }
    }
    swatches.addEventListener('click', (e) => {
      e.stopPropagation()
      const id = DYES.find(
        (d) =>
          e.target instanceof HTMLElement &&
          e.target.closest('[data-dye]')?.getAttribute('data-dye') === d.id,
      )?.id
      if (!id) {
        return
      }
      this.tryDye = id
      this.deps.preview(this.equipped, { ...this.dyes, [item.id]: id })
      this.renderDetail()
    })
    const name = DYES.find((d) => d.id === want)?.name ?? 'Natural'
    const price = dyePrice(item.id, want) ?? 0
    const me = this.deps.me()
    let label = `Dye ${name} · ${money(price)}`
    if (want === current) {
      label = current === 'natural' ? 'Pick a colour' : `Dyed ${name}`
    } else if (want === 'natural') {
      label = 'Wash it out · free'
    } else if (me && me.purse < price) {
      label = `Need ${money(price - me.purse)} more`
    }
    const go = button(box, label, () => {
      this.dye(item, want, price).catch(() => undefined)
    })
    go.disabled = want === current || this.busy || (me !== null && me.purse < price)
  }

  private async dye(item: CatalogItem, dye: DyeId, price: number): Promise<void> {
    const me = this.deps.me()
    if (!me || this.busy) {
      return
    }
    const colour = DYES.find((d) => d.id === dye)?.name ?? dye
    const yes = await confirmSheet(this.root.parentElement ?? this.root, {
      title: dye === 'natural' ? `Wash out ${item.name}?` : `Dye ${item.name} ${colour}?`,
      body:
        dye === 'natural'
          ? 'Back to its natural colour. Free.'
          : `${money(price)} from your purse of ${money(me.purse)}. Looks only, like everything here.`,
      yes: dye === 'natural' ? 'Wash it out' : `Dye · ${money(price)}`,
    })
    if (!yes) {
      return
    }
    this.busy = true
    const r = await dyeItem(item.id as ItemId, dye)
    this.busy = false
    if (!r.ok) {
      this.flash(r.error)
      return
    }
    uiSound('uiBuy')
    this.tryDye = null
    this.deps.changed({ purse: r.value.purse, dyes: r.value.dyes })
    this.deps.preview(this.equipped, r.value.dyes)
    this.show(this.slot)
  }

  private buyButton(item: CatalogItem, me: MeResponse | null): void {
    if (!me) {
      el('p', 'ow-hub-note', this.detail, 'Sign in with a passkey to buy and equip.')
      return
    }
    const verdict = canBuy({ level: me.level, purse: me.purse }, item, this.owned)
    const label: Record<string, string> = {
      ok: `Buy · ${money(item.price)}`,
      funds: `Need ${money(item.price - me.purse)} more`,
      level: `Unlocks at Lv ${item.level}`,
      not_for_sale: item.unlock ?? 'Not for sale',
      owned: 'Owned',
    }
    const b = button(
      this.detail,
      label[verdict] ?? 'Buy',
      () => {
        this.buy(item).catch(() => undefined)
      },
      true,
    )
    b.disabled = verdict !== 'ok' || this.busy
  }

  private async buy(item: CatalogItem): Promise<void> {
    const me = this.deps.me()
    if (!me || this.busy) {
      return
    }
    const yes = await confirmSheet(this.root.parentElement ?? this.root, {
      title: `Buy ${item.name}?`,
      body: `${money(item.price)} from your purse of ${money(me.purse)}. Cosmetic only, no refunds.`,
      yes: `Buy · ${money(item.price)}`,
    })
    if (!yes) {
      return
    }
    this.busy = true
    const r = await buyItem(item.id as ItemId)
    this.busy = false
    if (!r.ok) {
      this.flash(r.error)
      return
    }
    uiSound('uiBuy')
    this.owned = new Set(r.value.owned)
    this.deps.changed({ purse: r.value.purse, owned: r.value.owned })
    await this.equip({ ...this.equipped, [item.slot]: item.id })
  }

  private async equip(l: Loadout): Promise<void> {
    if (!this.deps.me()) {
      return
    }
    const r = await saveLoadout(l)
    if (!r.ok) {
      this.flash(r.error)
      return
    }
    this.deps.changed({ loadout: r.value.loadout })
    this.deps.preview(r.value.loadout)
    this.show(this.slot)
  }

  private flash(msg: string): void {
    this.detail.replaceChildren()
    el('p', 'ow-hub-note ow-store-error', this.detail, msg)
  }

  close(): void {
    this.deps.preview(this.equipped, this.dyes)
    this.root.classList.remove('on')
    setTimeout(() => this.root.remove(), 250)
    this.deps.close()
  }
}
