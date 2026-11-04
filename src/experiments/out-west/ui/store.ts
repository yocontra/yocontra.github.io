/**
 * The Outfitter: browse the catalog by slot or by matched set, see each piece rendered (a
 * thumbnail from the game's own models), rarity, level gates and "New" / "Can afford" badges, try
 * anything on your own character (the street stays live behind the panel), try dyes on any piece
 * that takes them, buy with a confirmation sheet, and equip. Cosmetic only; the server is the
 * authority on price, gates and ownership.
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
import { DYES, type DyeId, type Dyes, isDyeable } from '../data/dye.ts'
import { money } from '../data/economy.ts'
import { buyItem, fetchStore, saveLoadout } from '../net/api.ts'
import { dyeItem } from '../net/social.ts'
import { type IconName, icon } from './icons.ts'
import { uiSound } from './sfx.ts'
import { button, confirmSheet, el, swallow } from './sheet.ts'
import { dyePanel } from './store-dye.ts'
import { inReach, SETS, Shelf, setOf, wearSet } from './store-kit.ts'
import { BAKED_THUMBS } from './thumbs.ts'

const SLOT_TABS: readonly { slot: Slot; label: string }[] = [
  { slot: 'hat', label: 'Hats' },
  { slot: 'gun', label: 'Guns' },
  { slot: 'outfit', label: 'Outfits' },
  { slot: 'extra', label: 'Extras' },
  { slot: 'spurs', label: 'Spurs' },
  { slot: 'holster', label: 'Holsters' },
  { slot: 'frame', label: 'Frames' },
  { slot: 'drawSound', label: 'Draw sounds' },
  { slot: 'saddlebag', label: 'Saddlebags' },
]

type Tab = Slot | 'sets'

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
  drawSound: 'Plays when you fire in Bounty Hunt.',
  saddlebag: 'The bag you drop in Frontier.',
  holster: 'Looks only. Every gun draws the same.',
}

/** Thumbnails as image URLs, kept for the page: a canvas can only hang in one place. */
const ART = new Map<string, string>()

/** Hang a rendered thumbnail in a card's picture frame. */
function paint(art: HTMLElement, url: string): void {
  const img = el('img', '', null)
  img.src = url
  img.alt = ''
  img.decoding = 'async'
  art.replaceChildren(img)
  art.classList.add('drawn')
}

export interface StoreDeps {
  me: () => MeResponse | null
  /** Dress your character in this loadout (preview or equipped), with these dyes (yours if omitted). */
  preview: (l: Loadout, dyes?: Dyes) => void
  /** The server accepted a purchase, a dye job or a new loadout. */
  changed: (patch: Partial<MeResponse>) => void
  close: () => void
  /** Render one item's thumbnail (null: nothing to see, or the game isn't loaded). */
  thumb?: (id: ItemId) => HTMLCanvasElement | null
}

export class Outfitter {
  private readonly root: HTMLElement
  private readonly list: HTMLElement
  private readonly purseEl: HTMLElement
  private readonly detail: HTMLElement
  private readonly tabs = new Map<Tab, HTMLButtonElement>()
  private readonly deps: StoreDeps
  private items: readonly CatalogItem[] = CATALOG
  private owned = new Set<string>(STARTER_ITEMS)
  private tab: Tab = 'hat'
  private picked: CatalogItem | null = null
  /** A dye being tried on the picked item (not bought yet). */
  private tryDye: DyeId | null = null
  private busy = false as boolean
  private shelf: Shelf | null = null
  /** Cards waiting for their thumbnail, rendered one per frame. */
  private readonly waiting: { id: ItemId; art: HTMLElement }[] = []
  private drawing = false as boolean

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
    const tabButton = (t: Tab, label: string, ic: IconName): void => {
      const b = el('button', 'ow-store-tab', tabs)
      b.type = 'button'
      b.append(icon(ic), label)
      b.setAttribute('role', 'tab')
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        this.show(t)
      })
      this.tabs.set(t, b)
    }
    for (const t of SLOT_TABS) {
      tabButton(t.slot, t.label, SLOT_ICON[t.slot])
    }
    tabButton('sets', 'Sets', 'badge')
    this.list = el('div', 'ow-store-list', this.root)
    this.detail = el('div', 'ow-store-detail', this.root)
    const me = deps.me()
    if (me) {
      this.owned = new Set(me.owned)
      this.shelf = new Shelf(me.accountId, this.items, me.level, this.owned)
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
    const me = this.deps.me()
    if (me) {
      this.owned = new Set(r.value.owned)
      // built once per visit: a second read would see this visit's first tab as already looked at
      this.shelf ??= new Shelf(me.accountId, this.items, me.level, this.owned)
    }
    this.show(this.tab)
  }

  private get equipped(): Loadout {
    return normalizeLoadout(this.deps.me()?.loadout ?? DEFAULT_LOADOUT)
  }

  private show(tab: Tab): void {
    this.tab = tab
    const me = this.deps.me()
    for (const [t, b] of this.tabs) {
      b.classList.toggle('on', t === tab)
      b.setAttribute('aria-selected', String(t === tab))
      const fresh =
        t === 'sets' ? 0 : (this.shelf?.newIn(this.items.filter((i) => i.slot === t)) ?? 0)
      b.classList.toggle('fresh', fresh > 0)
      b.title = fresh > 0 ? `${fresh} new` : ''
    }
    this.purseEl.replaceChildren()
    this.purseEl.classList.toggle('guest', !me)
    if (me) {
      this.purseEl.append(icon('money'), `${money(me.purse)} · Lv ${me.level}`)
    } else {
      this.purseEl.textContent = 'Sign in to buy'
    }
    this.list.replaceChildren()
    this.waiting.length = 0
    if (tab === 'sets') {
      this.renderSets()
      this.renderDetail()
      return
    }
    const eq = this.equipped
    const here = this.items.filter((i) => i.slot === tab)
    for (const item of here) {
      this.card(item, eq)
    }
    if (tab === 'extra') {
      this.noneCard(eq)
    }
    // the badges have been seen: they go quiet next visit
    this.shelf?.look(here)
    this.renderDetail()
    this.drawThumbs()
  }

  /** The picture on a card: the rendered piece when the game can draw it, else its slot icon. */
  private art(card: HTMLElement, item: CatalogItem): void {
    const art = el('span', 'ow-item-art', card)
    art.setAttribute('aria-hidden', 'true')
    // baked at build time (tools/item-thumbs.ts): no dressing on the main thread at all
    const url = BAKED_THUMBS.has(item.id)
      ? `/experiments/out-west/thumbs/${item.id}.webp`
      : ART.get(item.id)
    if (url) {
      paint(art, url)
      return
    }
    art.append(icon(SLOT_ICON[item.slot]))
    if (this.deps.thumb) {
      this.waiting.push({ id: item.id as ItemId, art })
    }
  }

  /** One thumbnail per frame, so a tab of new pieces never hitches the street behind. */
  private drawThumbs(): void {
    if (this.drawing || !this.deps.thumb) {
      return
    }
    this.drawing = true
    const step = (): void => {
      const next = this.waiting.shift()
      if (!(next && this.root.isConnected)) {
        this.drawing = false
        return
      }
      const have = ART.get(next.id)
      if (have !== undefined) {
        if (have && next.art.isConnected) {
          paint(next.art, have)
        }
        requestAnimationFrame(step)
        return
      }
      const c = this.deps.thumb?.(next.id)
      if (!c) {
        ART.set(next.id, '')
        requestAnimationFrame(step)
        return
      }
      // the image encode runs off the frame (toDataURL blocked it for tens of ms on a phone),
      // and the next piece waits for it, so each frame dresses at most one
      c.toBlob(
        (blob) => {
          const url = blob ? URL.createObjectURL(blob) : ''
          ART.set(next.id, url)
          if (url && next.art.isConnected) {
            paint(next.art, url)
          }
          requestAnimationFrame(step)
        },
        'image/webp',
        0.9,
      )
    }
    requestAnimationFrame(step)
  }

  private card(item: CatalogItem, eq: Loadout): void {
    const me = this.deps.me()
    const b = el('button', `ow-item r-${item.rarity}`, this.list)
    b.type = 'button'
    b.classList.toggle('picked', this.picked?.id === item.id)
    this.art(b, item)
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
    const badges = el('span', 'ow-item-badges', b)
    if (this.shelf?.isNew(item.id)) {
      el('span', 'ow-item-badge new', badges, 'New')
    }
    if (me && inReach(item, me.level, this.owned) && me.purse >= item.price) {
      el('span', 'ow-item-badge afford', badges, 'Can afford')
    }
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      this.pick(item)
    })
  }

  private noneCard(eq: Loadout): void {
    const b = el('button', 'ow-item r-starter', this.list)
    b.type = 'button'
    el('span', 'ow-item-art', b).append(icon('badge'))
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

  /** The Sets tab: each matched set, how much of it you own, and one tap to try it all on. */
  private renderSets(): void {
    for (const set of SETS) {
      const pieces = set.items
        .map((id) => this.items.find((i) => i.id === id))
        .filter((i): i is CatalogItem => i !== undefined)
      const have = pieces.filter((i) => this.owned.has(i.id)).length
      const box = el('div', 'ow-set-card', this.list)
      el('b', 'ow-store-name', box, set.name)
      el('p', 'ow-hub-note', box, `${set.blurb} Owned: ${have}/${pieces.length}`)
      const row = el('div', 'ow-set-pieces', box)
      for (const p of pieces) {
        const chip = el('button', `ow-set-piece${this.owned.has(p.id) ? ' owned' : ''}`, row)
        chip.type = 'button'
        this.art(chip, p)
        el('span', '', chip, p.name)
        chip.addEventListener('click', (e) => {
          e.stopPropagation()
          this.tab = p.slot
          this.pick(p)
        })
      }
      button(box, 'Try on', () => {
        this.picked = null
        this.deps.preview(wearSet(this.equipped, set, this.items))
      })
    }
    this.drawThumbs()
  }

  private get dyes(): Dyes {
    return this.deps.me()?.dyes ?? {}
  }

  private pick(item: CatalogItem): void {
    this.picked = item
    this.tryDye = null
    this.deps.preview({ ...this.equipped, [item.slot]: item.id })
    this.show(item.slot)
  }

  private renderDetail(): void {
    this.detail.replaceChildren()
    const item = this.picked
    if (!item || item.slot !== this.tab) {
      // nothing picked: only a note the shelf can't say for itself (what a frame is for)
      const idle =
        this.tab === 'sets' ? 'Each piece is sold on its own.' : (SLOT_NOTE[this.tab] ?? null)
      if (idle) {
        el('p', 'ow-hub-note', this.detail, idle)
      }
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
    const set = setOf(item.id)
    if (set) {
      const have = set.items.filter((id) => this.owned.has(id)).length
      const line = el('p', 'ow-hub-note ow-store-set', this.detail)
      line.append(`${set.name} set · Owned: ${have}/${set.items.length} · `)
      const see = el('button', 'ow-store-link', line, 'See the set')
      see.type = 'button'
      see.addEventListener('click', (e) => {
        e.stopPropagation()
        this.picked = null
        this.show('sets')
      })
    }
    const me = this.deps.me()
    const mine = this.owned.has(item.id)
    if (mine) {
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
    } else {
      this.buyButton(item, me)
    }
    if (isDyeable(item)) {
      const current: DyeId = (mine && this.dyes[item.id as ItemId]) || 'natural'
      dyePanel(this.detail, {
        item,
        current,
        want: this.tryDye ?? current,
        owned: mine,
        purse: me?.purse ?? null,
        busy: this.busy,
        onTry: (id) => {
          this.tryDye = id
          this.deps.preview(
            { ...this.equipped, [item.slot]: item.id },
            { ...this.dyes, [item.id]: id },
          )
          this.renderDetail()
        },
        onDye: (want, price) => {
          this.dye(item, want, price).catch(() => undefined)
        },
      })
    }
  }

  private async dye(item: CatalogItem, dye: DyeId, price: number): Promise<void> {
    const me = this.deps.me()
    if (!me || this.busy) {
      return
    }
    const colour = DYES.find((d) => d.id === dye)?.name ?? dye
    const yes = await confirmSheet(this.root.parentElement ?? this.root, {
      title: dye === 'natural' ? `Remove dye from ${item.name}?` : `Dye ${item.name} ${colour}?`,
      body:
        dye === 'natural'
          ? 'Back to its natural colour. Free.'
          : `Costs ${money(price)}. You have ${money(me.purse)}.`,
      yes: dye === 'natural' ? 'Remove dye' : `Dye · ${money(price)}`,
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
    this.show(this.tab)
  }

  private buyButton(item: CatalogItem, me: MeResponse | null): void {
    if (!me) {
      el('p', 'ow-hub-note', this.detail, 'Sign in to buy and equip.')
      return
    }
    const verdict = canBuy({ level: me.level, purse: me.purse }, item, this.owned)
    const label: Record<string, string> = {
      ok: `Buy · ${money(item.price)}`,
      funds: `Need ${money(item.price - me.purse)} more`,
      level: `Unlocks at level ${item.level}`,
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
      body: `Costs ${money(item.price)}. You have ${money(me.purse)}. No refunds.`,
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
    this.show(this.tab)
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
