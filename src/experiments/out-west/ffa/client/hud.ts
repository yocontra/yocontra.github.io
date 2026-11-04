// biome-ignore-all lint/complexity/useMaxParams: the reticle setter takes its per-frame state positionally to avoid allocating
/**
 * The Frontier HUD, all DOM above the canvas (crisp at any DPR, never waits on WebGL): health,
 * the six rounds and the reload, carried and banked cash, the channel bar (bank 2 s, Stage Line
 * 4 s, strongbox 3 s, leaving 5 s), the kill feed, toasts, the contextual prompt, the Dead-Eye
 * reticle, the hit marker, the hurt flash, the death poster with the respawn countdown, and the
 * menu (leave town). Every write is skipped when the value hasn't changed.
 */
import { icon } from '../../ui/icons.ts'
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
  /** The head count was tapped: who's in town. */
  onRiders: () => void
  /** The death card's "Wanted poster": your killer's. */
  onKiller: () => void
  /** The pause menu opened or closed (the game frees or retakes the mouse). */
  onMenu?: (open: boolean) => void
  /** The pause menu's "How to play". */
  onHowTo?: () => void
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
  private readonly playersEl: HTMLButtonElement
  private readonly tcEl: HTMLElement
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
  private readonly deathPoster: HTMLButtonElement
  private readonly bannerEl: HTMLElement
  private readonly menuEl: HTMLElement
  /** The pause card (the settings panel mounts in `menuSettings`). */
  readonly menuSettings: HTMLElement
  private readonly opts: HudOptions
  private readonly ticks: HTMLElement
  private readonly rotateEl: HTMLElement
  private readonly clickEl: HTMLElement
  private readonly protectEl: HTMLElement
  private readonly lowPowerEl: HTMLElement
  readonly mapSlot: HTMLElement
  private readonly last = new Map<string, string | number | boolean>()
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private rotateSaid = false
  private readonly dmg: HTMLElement[] = []
  private dmgNext = 0

  constructor(parent: HTMLElement, opts: HudOptions) {
    this.opts = opts
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
    this.dynamiteEl = el('div', 'fr-dynamite', vitals, opts.touch ? 'Dynamite' : 'Dynamite · G')
    this.dynamiteEl.prepend(icon('dynamite'))
    this.protectEl = el('div', 'fr-protect', vitals, 'PROTECTED')

    // The money readout: only the banked purse until you carry cash, then the carry, big, with an
    // AT RISK tag (it drops if you die).
    this.tcEl = el('div', 'fr-tc', this.root)
    const carry = el('div', 'fr-carry', this.tcEl)
    this.carriedEl = el('div', 'fr-carried', carry, '$0')
    el('div', 'fr-carried-label', carry, 'at risk')
    this.bankedEl = el('div', 'fr-banked', this.tcEl, '$0 banked')
    this.mwEl = el('div', 'fr-mw', this.tcEl, '★ MOST WANTED · +50%')

    const tr = el('div', 'fr-tr', this.root)
    this.mapSlot = el('div', 'fr-map-slot', tr)
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
    // the shooter crosshair: four ticks that open with the spread, and a centre dot
    this.ticks = el('div', 'fr-ticks', this.reticle)
    for (const side of ['t', 'r', 'b', 'l']) {
      el('div', `fr-tick fr-tick-${side}`, this.ticks)
    }
    el('div', 'fr-dot', this.ticks)
    this.hitEl = el('div', 'fr-hitmark', this.reticle)
    const ring = el('div', 'fr-dmg-ring', this.root)
    for (let i = 0; i < 4; i++) {
      this.dmg.push(el('div', 'fr-dmg', ring))
    }
    this.bannerEl = el('div', 'fr-banner', this.root)
    this.lowPowerEl = el('div', 'fr-lowpower', this.root, 'Low Power Mode: 30 fps')
    this.rotateEl = el('div', 'fr-rotate', this.root, 'Turn your phone sideways for the best view')
    this.clickEl = el('div', 'fr-rotate fr-click', this.root, 'Click to take aim')

    this.deathEl = el('div', 'fr-death', this.root)
    const poster = el('div', 'fr-poster', this.deathEl)
    el('div', 'fr-poster-head', poster, 'SHOT DOWN BY')
    this.deathName = el('div', 'fr-poster-name', poster)
    this.deathSub = el('div', 'fr-poster-sub', poster)
    this.deathCount = el('div', 'fr-poster-count', poster)
    this.deathPoster = el(
      'button',
      'fr-menu-item fr-hit fr-poster-link',
      poster,
      'His wanted poster',
    )
    this.deathPoster.type = 'button'
    this.deathPoster.hidden = true
    this.deathPoster.addEventListener('click', (e) => {
      e.stopPropagation()
      opts.onKiller()
    })

    this.menuEl = el('div', 'fr-menu fr-hit', this.root)
    const card = el('div', 'fr-menu-card', this.menuEl)
    el('h2', 'fr-menu-title', card, 'Perdition')
    el(
      'p',
      'fr-menu-note',
      card,
      'Carried cash drops when you leave, unless you leave from inside the bank. Banked money is safe.',
    )
    const howto = el('button', 'fr-menu-item fr-menu-quiet fr-hit', card, 'How to play')
    // who's in town (report and block live there)
    this.playersEl = el('button', 'fr-menu-item fr-menu-quiet fr-hit', card, 'Riders in town')
    this.menuSettings = el('div', 'fr-menu-settings', card)
    const leave = el('button', 'fr-menu-item fr-hit', card, 'Leave town (5 s)')
    const exit = el(
      'button',
      'fr-menu-item fr-menu-quiet fr-hit',
      card,
      'Quit now (drop your carry)',
    )
    const back = el('button', 'fr-menu-item fr-menu-quiet fr-hit', card, 'Back to the fight')
    const players = this.playersEl
    players.addEventListener('click', (e) => {
      e.stopPropagation()
      close()
      opts.onRiders()
    })
    for (const b of [howto, players, leave, exit, back]) {
      b.type = 'button'
    }
    const close = () => this.setMenu(false)
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleMenu()
    })
    back.addEventListener('click', (e) => {
      e.stopPropagation()
      close()
    })
    howto.addEventListener('click', (e) => {
      e.stopPropagation()
      close()
      opts.onHowTo?.()
    })
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
    this.setMenu(!this.menuOpen)
  }

  setMenu(open: boolean): void {
    if (open === this.menuOpen) {
      return
    }
    this.menuEl.classList.toggle('on', open)
    this.opts.onMenu?.(open)
  }

  /** Desktop shooter view without the pointer lock: "Click to take aim". */
  clickHint(on: boolean): void {
    if (this.changed('click', on)) {
      this.clickEl.classList.toggle('on', on)
    }
  }

  /** Portrait phone in a shooter view: a polite hint to turn sideways (play still works). */
  rotateHint(on: boolean): void {
    if (this.changed('rot', on)) {
      // said once, for four seconds: a fixture over the fight is noise
      this.rotateEl.classList.toggle('on', on && !this.rotateSaid)
      if (on && !this.rotateSaid) {
        this.rotateSaid = true
        setTimeout(() => this.rotateEl.classList.remove('on'), 4000)
      }
    }
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
    if (this.changed('carry', s.carried > 0)) {
      this.tcEl.classList.toggle('carry', s.carried > 0)
    }
    if (this.changed('carried', s.carried)) {
      this.carriedEl.textContent = money(s.carried)
      this.carriedEl.classList.remove('bump')
      this.carriedEl.getBoundingClientRect()
      this.carriedEl.classList.add('bump')
    }
    if (this.changed('banked', s.banked)) {
      this.bankedEl.textContent = `${money(s.banked)} banked`
      this.bankedEl.hidden = s.banked <= 0
    }
    if (this.changed('players', s.players)) {
      this.playersEl.textContent = `Riders in town (${s.players})`
    }
    if (this.changed('mw', s.mostWanted)) {
      this.mwEl.classList.toggle('on', s.mostWanted)
    }
    if (this.changed('prot', s.protectedFor > 0)) {
      this.protectEl.classList.toggle('on', s.protectedFor > 0)
    }
    if (this.changed('lp', s.lowPower)) {
      // a notice, not a fixture: up for five seconds when Low Power Mode kicks in
      this.lowPowerEl.classList.toggle('on', s.lowPower)
      if (s.lowPower) {
        setTimeout(() => this.lowPowerEl.classList.remove('on'), 5000)
      }
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

  /**
   * One line in the kill feed. Portrait phones keep 2 single-line rows that fade after 3 s (the
   * feed shares the narrow top-right with the map); everywhere else, 4 rows for 4 s.
   */
  feed(html: string, kind: FeedKind): void {
    const portrait = matchMedia('(orientation: portrait)').matches
    const row = el('div', `fr-feed-row fr-feed-${kind}`, this.feedEl)
    row.textContent = html
    row.title = html
    while (this.feedEl.childElementCount > (portrait ? 2 : 4)) {
      this.feedEl.firstElementChild?.remove()
    }
    const ms = portrait ? 3000 : 4000
    setTimeout(() => row.classList.add('out'), ms)
    setTimeout(() => row.remove(), ms + 500)
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
    // Flash in instantly, then fade out (inline styles, so the fade always wins over the flash).
    const st = this.hurtEl.style
    st.transition = 'none'
    st.opacity = String(Math.min(0.9, 0.25 + amount / 70))
    this.hurtEl.getBoundingClientRect()
    st.transition = 'opacity 0.6s ease-out'
    st.opacity = '0'
  }

  /** The hit marker: white for a hit, red for a kill, gold for a Dead-Eye (critical) hit. */
  hit(kill: boolean, crit = false): void {
    this.hitEl.className = `fr-hitmark on${kill ? ' kill' : ''}${crit ? ' crit' : ''}`
    this.hitEl.getBoundingClientRect()
    this.hitEl.classList.add('fade')
  }

  /**
   * A red arc on a ring around the crosshair, pointing where the hit came from: `angle` is
   * clockwise from straight ahead (radians). Fades over a second; four at most.
   */
  damageArc(angle: number): void {
    const a = this.dmg[this.dmgNext % this.dmg.length]
    this.dmgNext++
    if (!a) {
      return
    }
    a.style.transform = `rotate(${angle}rad)`
    a.classList.remove('on')
    a.getBoundingClientRect()
    a.classList.add('on')
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
    const at = `translate(${Math.round(x * 2) / 2}px, ${Math.round(y * 2) / 2}px)`
    if (this.changed('retxy', at)) {
      this.reticle.style.transform = at
    }
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

  /**
   * Shooter views: the crosshair sits at the screen centre; `spread` is the gap of its ticks (px),
   * `onTarget` turns it red over a rider in range.
   */
  setCrosshair(shooter: boolean, spread: number, onTarget: boolean): void {
    if (this.changed('xshoot', shooter)) {
      this.reticle.classList.toggle('shooter', shooter)
    }
    if (!shooter) {
      return
    }
    const gap = Math.round(spread * 2) / 2
    if (this.changed('xgap', gap)) {
      this.ticks.style.setProperty('--gap', `${gap}px`)
    }
    if (this.changed('xtgt', onTarget)) {
      this.reticle.classList.toggle('target', onTarget)
    }
  }

  /** The death card; `person` shows the link to the killer's poster (a player, not a bot). */
  death(killer: string | null, sub: string, seconds: number, person = false): void {
    if (this.changed('death', killer ?? '\u0000')) {
      this.deathEl.classList.add('on')
      this.deathName.textContent = killer ?? 'The frontier'
      this.deathSub.textContent = sub
      this.deathPoster.hidden = !person
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
