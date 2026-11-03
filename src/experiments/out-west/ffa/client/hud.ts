// biome-ignore-all lint/complexity/useMaxParams: the reticle setter takes its per-frame state positionally to avoid allocating
/**
 * The Frontier HUD, all DOM above the canvas (crisp at any DPR, never waits on WebGL): health,
 * the six rounds and the reload, carried and banked cash, the channel bar (bank 2 s, Stage Line
 * 4 s, strongbox 3 s, leaving 5 s), the kill feed, toasts, the contextual prompt, the Dead-Eye
 * reticle, the hit marker, the hurt flash, the death poster with the respawn countdown, and the
 * menu (leave town). Every write is skipped when the value hasn't changed.
 */
import { REVOLVER_ROUNDS } from '../sim/constants.ts'

export interface HudState {
  /** Gun in hand: label and magazine size; and whether you hold dynamite. */
  weapon: { label: string; max: number }
  dynamite: boolean
  hp: number
  ammo: number
  /** 0..1 while reloading, else null. */
  reload: number | null
  carried: number
  banked: number
  players: number
  mostWanted: boolean
  /** Channel label and 0..1 progress, or null. */
  channel: { label: string; t: number } | null
  /** Contextual action prompt, or null. */
  prompt: string | null
  protectedFor: number
  lowPower: boolean
}

export type FeedKind = 'kill' | 'you' | 'died' | 'info' | 'gold'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  parent: HTMLElement,
  text = '',
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text) {
    e.textContent = text
  }
  parent.append(e)
  return e
}

const money = (n: number): string => `$${Math.max(0, Math.round(n)).toLocaleString('en-US')}`

export interface HudOptions {
  touch: boolean
  onLeave: () => void
  onExit: () => void
}

export class Hud {
  readonly root: HTMLElement
  private readonly hpFill: HTMLElement
  private readonly hpText: HTMLElement
  private readonly pips: HTMLElement[] = []
  private readonly reloadEl: HTMLElement
  private readonly weaponEl: HTMLElement
  private readonly dynamiteEl: HTMLElement
  private readonly carriedEl: HTMLElement
  private readonly bankedEl: HTMLElement
  private readonly playersEl: HTMLElement
  private readonly mwEl: HTMLElement
  private readonly channelEl: HTMLElement
  private readonly channelFill: HTMLElement
  private readonly channelLabel: HTMLElement
  private readonly promptEl: HTMLElement
  private readonly feedEl: HTMLElement
  private readonly toastEl: HTMLElement
  private readonly hurtEl: HTMLElement
  private readonly reticle: HTMLElement
  private readonly hitEl: HTMLElement
  private readonly deathEl: HTMLElement
  private readonly deathName: HTMLElement
  private readonly deathSub: HTMLElement
  private readonly deathCount: HTMLElement
  private readonly bannerEl: HTMLElement
  private readonly menuEl: HTMLElement
  private readonly protectEl: HTMLElement
  private readonly lowPowerEl: HTMLElement
  readonly mapSlot: HTMLElement
  private readonly last = new Map<string, string | number | boolean>()
  private toastTimer: ReturnType<typeof setTimeout> | null = null

  constructor(parent: HTMLElement, opts: HudOptions) {
    this.root = el('div', `fr-hud fr-ui${opts.touch ? ' fr-touchui' : ''}`, parent)
    const tl = el('div', 'fr-tl', this.root)
    const menuBtn = el('button', 'fr-menu-btn fr-hit', tl, '≡')
    menuBtn.type = 'button'
    menuBtn.setAttribute('aria-label', 'Menu')
    const vitals = el('div', 'fr-vitals', tl)
    const hp = el('div', 'fr-hp', vitals)
    this.hpFill = el('div', 'fr-hp-fill', hp)
    this.hpText = el('div', 'fr-hp-text', hp, '100')
    const ammo = el('div', 'fr-ammo', vitals)
    for (let i = 0; i < REVOLVER_ROUNDS; i++) {
      this.pips.push(el('div', 'fr-pip', ammo))
    }
    this.reloadEl = el('div', 'fr-reload', ammo, 'RELOADING')
    this.weaponEl = el('div', 'fr-weapon', vitals)
    this.dynamiteEl = el('div', 'fr-dynamite', vitals, '🧨 DYNAMITE: G / THROW')
    this.protectEl = el('div', 'fr-protect', vitals, 'PROTECTED')

    const tc = el('div', 'fr-tc', this.root)
    this.carriedEl = el('div', 'fr-carried', tc, '$0')
    el('div', 'fr-carried-label', tc, 'carried')
    this.bankedEl = el('div', 'fr-banked', tc, 'banked $0')
    this.mwEl = el('div', 'fr-mw', tc, '★ MOST WANTED')

    const tr = el('div', 'fr-tr', this.root)
    this.mapSlot = el('div', 'fr-map-slot', tr)
    this.playersEl = el('div', 'fr-players', tr, '')
    this.feedEl = el('div', 'fr-feed', tr)

    this.channelEl = el('div', 'fr-channel', this.root)
    this.channelLabel = el('div', 'fr-channel-label', this.channelEl)
    const bar = el('div', 'fr-channel-bar', this.channelEl)
    this.channelFill = el('div', 'fr-channel-fill', bar)
    this.promptEl = el('div', 'fr-prompt', this.root)
    this.toastEl = el('div', 'fr-toast', this.root)
    this.hurtEl = el('div', 'fr-hurt', this.root)
    this.reticle = el('div', 'fr-reticle', this.root)
    el('div', 'fr-reticle-ring', this.reticle)
    this.hitEl = el('div', 'fr-hitmark', this.reticle)
    this.bannerEl = el('div', 'fr-banner', this.root)
    this.lowPowerEl = el('div', 'fr-lowpower', this.root, 'Low Power Mode: 30 fps')

    this.deathEl = el('div', 'fr-death', this.root)
    const poster = el('div', 'fr-poster', this.deathEl)
    el('div', 'fr-poster-head', poster, 'SHOT DOWN BY')
    this.deathName = el('div', 'fr-poster-name', poster)
    this.deathSub = el('div', 'fr-poster-sub', poster)
    this.deathCount = el('div', 'fr-poster-count', poster)

    this.menuEl = el('div', 'fr-menu fr-hit', this.root)
    const card = el('div', 'fr-menu-card', this.menuEl)
    el('h2', 'fr-menu-title', card, 'Perdition')
    el(
      'p',
      'fr-menu-note',
      card,
      'Carried cash drops when you leave, unless you leave from inside the bank. Banked money is safe.',
    )
    const leave = el('button', 'fr-menu-item fr-hit', card, 'Leave town (5 s)')
    const exit = el(
      'button',
      'fr-menu-item fr-menu-quiet fr-hit',
      card,
      'Quit now (drop your carry)',
    )
    const back = el('button', 'fr-menu-item fr-menu-quiet fr-hit', card, 'Back to the fight')
    for (const b of [leave, exit, back]) {
      b.type = 'button'
    }
    const close = () => this.menuEl.classList.remove('on')
    menuBtn.addEventListener('click', () => this.menuEl.classList.toggle('on'))
    back.addEventListener('click', close)
    leave.addEventListener('click', () => {
      close()
      opts.onLeave()
    })
    exit.addEventListener('click', () => {
      close()
      opts.onExit()
    })
  }

  get menuOpen(): boolean {
    return this.menuEl.classList.contains('on')
  }

  toggleMenu(): void {
    this.menuEl.classList.toggle('on')
  }

  private changed(key: string, v: string | number | boolean): boolean {
    if (this.last.get(key) === v) {
      return false
    }
    this.last.set(key, v)
    return true
  }

  update(s: HudState): void {
    const hp = Math.max(0, Math.round(s.hp))
    if (this.changed('hp', hp)) {
      this.hpFill.style.transform = `scaleX(${hp / 100})`
      this.hpFill.classList.toggle('low', hp <= 34)
      this.hpText.textContent = String(hp)
    }
    if (this.changed('ammo', `${s.ammo}/${s.weapon.max}`)) {
      for (const [i, p] of this.pips.entries()) {
        p.classList.toggle('spent', i >= s.ammo)
        p.hidden = i >= s.weapon.max
      }
    }
    if (this.changed('weapon', s.weapon.label)) {
      this.weaponEl.textContent = s.weapon.label
      this.weaponEl.classList.toggle('on', s.weapon.label !== '')
    }
    if (this.changed('dyn', s.dynamite)) {
      this.dynamiteEl.classList.toggle('on', s.dynamite)
    }
    const reloading = s.reload !== null
    if (this.changed('reload', reloading)) {
      this.reloadEl.classList.toggle('on', reloading)
    }
    if (this.changed('carried', s.carried)) {
      this.carriedEl.textContent = money(s.carried)
      this.carriedEl.classList.remove('bump')
      this.carriedEl.getBoundingClientRect()
      this.carriedEl.classList.add('bump')
    }
    if (this.changed('banked', s.banked)) {
      this.bankedEl.textContent = `banked ${money(s.banked)}`
    }
    if (this.changed('players', s.players)) {
      this.playersEl.textContent = `${s.players} in Perdition`
    }
    if (this.changed('mw', s.mostWanted)) {
      this.mwEl.classList.toggle('on', s.mostWanted)
    }
    if (this.changed('prot', s.protectedFor > 0)) {
      this.protectEl.classList.toggle('on', s.protectedFor > 0)
    }
    if (this.changed('lp', s.lowPower)) {
      this.lowPowerEl.classList.toggle('on', s.lowPower)
    }
    const ch = s.channel
    if (this.changed('ch', ch ? ch.label : '')) {
      this.channelEl.classList.toggle('on', ch !== null)
      this.channelLabel.textContent = ch?.label ?? ''
    }
    if (ch) {
      this.channelFill.style.transform = `scaleX(${Math.min(1, ch.t)})`
    }
    if (this.changed('prompt', s.prompt ?? '')) {
      this.promptEl.textContent = s.prompt ?? ''
      this.promptEl.classList.toggle('on', s.prompt !== null)
    }
  }

  feed(html: string, kind: FeedKind): void {
    const row = el('div', `fr-feed-row fr-feed-${kind}`, this.feedEl)
    row.textContent = html
    while (this.feedEl.childElementCount > 5) {
      this.feedEl.firstElementChild?.remove()
    }
    setTimeout(() => row.classList.add('out'), 5000)
    setTimeout(() => row.remove(), 5600)
  }

  toast(text: string, kind = '', ms = 1800): void {
    this.toastEl.textContent = text
    this.toastEl.className = `fr-toast on ${kind}`
    if (this.toastTimer) {
      clearTimeout(this.toastTimer)
    }
    this.toastTimer = setTimeout(() => {
      this.toastEl.classList.remove('on')
    }, ms)
  }

  hurt(amount: number): void {
    this.hurtEl.style.opacity = String(Math.min(0.9, 0.25 + amount / 70))
    this.hurtEl.classList.remove('fade')
    this.hurtEl.getBoundingClientRect()
    this.hurtEl.classList.add('fade')
  }

  hit(kill: boolean): void {
    this.hitEl.className = `fr-hitmark on${kill ? ' kill' : ''}`
    this.hitEl.getBoundingClientRect()
    this.hitEl.classList.add('fade')
  }

  /**
   * Reticle at client (x, y). `close` is the Dead-Eye reticle closing (0 open … 1 closed),
   * `ready` flashes it, null hides the ring (the plain crosshair stays).
   */
  setReticle(x: number, y: number, visible: boolean, close: number | null, ready: boolean): void {
    if (this.changed('retv', visible)) {
      this.reticle.classList.toggle('on', visible)
    }
    if (!visible) {
      return
    }
    this.reticle.style.transform = `translate(${x}px, ${y}px)`
    let k = 'n'
    if (close !== null) {
      k = ready ? 'r' : 'c'
    }
    if (this.changed('retk', k)) {
      this.reticle.classList.toggle('dead-eye', close !== null)
      this.reticle.classList.toggle('ready', ready)
    }
    if (close !== null) {
      this.reticle.style.setProperty('--close', String(close))
    }
  }

  death(killer: string | null, sub: string, seconds: number): void {
    if (this.changed('death', killer ?? '\u0000')) {
      this.deathEl.classList.add('on')
      this.deathName.textContent = killer ?? 'The frontier'
      this.deathSub.textContent = sub
    }
    const s = Math.ceil(seconds)
    if (this.changed('deathS', s)) {
      this.deathCount.textContent = s > 0 ? `Back in the saddle in ${s}…` : ''
    }
  }

  alive(): void {
    if (this.changed('death', '')) {
      this.deathEl.classList.remove('on')
    }
  }

  banner(text: string | null): void {
    if (this.changed('banner', text ?? '')) {
      this.bannerEl.textContent = text ?? ''
      this.bannerEl.classList.toggle('on', text !== null)
    }
  }

  dispose(): void {
    if (this.toastTimer) {
      clearTimeout(this.toastTimer)
    }
    this.root.remove()
  }
}
