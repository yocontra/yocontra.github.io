// biome-ignore-all lint/style/useThisInClassMethods: private helpers kept on the class next to the state they describe
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: stick and button state is mutated from pointer callbacks; Biome narrows them to their initialisers
// biome-ignore-all lint/style/noExcessiveLinesPerFile: the whole thumb layer is one state machine
/**
 * Touch controls, as DOM in their own layer above the canvas so input never waits on WebGL (spec
 * §3.8). The shooter layout copies Call of Duty Mobile:
 *
 * - a fixed move stick at the bottom-left (the CODM thumbstick) with a dead zone and an optional
 *   auto-sprint: push it forward and out and the rider sprints until the stick comes back;
 * - the right half of the screen is the look pad: drag anywhere on it to turn, and a drag that
 *   starts on FIRE keeps looking while it fires;
 * - FIRE is the big button at the right thumb; AIM sits beside it and holds the sights (or toggles,
 *   a setting); JUMP and CROUCH/SLIDE sit above them, RELOAD and THROW to their left, and the
 *   contextual button (BANK, SHIP, OPEN, ACCEPT, CALL OUT) above the cluster;
 * - a left-handed layout mirrors the whole thing, and the button and stick sizes are settings.
 *
 * Top-down (kept as an option): the original twin-stick. The right stick aims while dragged and
 * fires on release (flick-to-fire); holding it 400 ms from the holster closes the Dead-Eye
 * reticle.
 *
 * Every target is at least 48 CSS px (the audit's floor is 44).
 */
import {
  BTN_AIM,
  BTN_FIRE,
  BTN_RELOAD,
  BTN_ROLL,
  BTN_SPRINT,
  BTN_THROW,
} from '../../contract/town.ts'
import { CROUCH_TAP, JUMP_BIT } from './bindings.ts'
import type { Sampled } from './controls.ts'
import type { FrontierSettings } from './settings.ts'

/** The stick's base radius in CSS px at scale 1. */
const STICK_R = 56
/** Fraction of the stick that does nothing, so a resting thumb never drifts. */
const DEAD_FRAC = 0.13
/** Sprint: the thumb past this share of the ring, within `SPRINT_CONE` of straight up. */
const SPRINT_ON = 0.9
const SPRINT_OFF = 0.68
const SPRINT_CONE = Math.cos((40 * Math.PI) / 180)
const TAP_MS = 220
/** World z is foreshortened on screen by sin(pitch) at the 58° camera. */
const PITCH_SIN = Math.sin((58 * Math.PI) / 180)

interface Stick {
  id: number
  ox: number
  oy: number
  x: number
  y: number
  t0: number
  moved: boolean
  base: HTMLElement
  knob: HTMLElement
}

function el(cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement('div')
  e.className = cls
  if (text) {
    e.textContent = text
  }
  parent.append(e)
  return e
}

export class TouchControls {
  readonly layer: HTMLElement
  private left: Stick | null = null
  private right: Stick | null = null
  private readonly leftBase: HTMLElement
  private readonly leftKnob: HTMLElement
  private readonly rightBase: HTMLElement
  private readonly rightKnob: HTMLElement
  private readonly action: HTMLElement
  private readonly throwBtn: HTMLElement
  private readonly adsBtn: HTMLElement
  private readonly fireBtn: HTMLElement
  private readonly crouchBtn: HTMLElement
  private readonly sprintBtn: HTMLElement
  /** Auto-sprint: the left stick has been pushed forward far enough. */
  private sprint = false
  /** The SPRINT button is held (a setting hides it when auto-sprint is on). */
  private sprintHeld = false
  private actionBit = 0
  private latched = 0
  /** BTN_AIM kept for the release frame so a Dead-Eye release still counts as aimed. */
  private aimHold = 0
  private aim: number | null = null
  active = false
  /** The thumbs take input (false while dead or a full-screen card is up). */
  private enabled = true
  /** Shooter layout (look by drag, FIRE / AIM buttons) or the top-down twin-stick. */
  private shooter = false
  /** The look finger (right side, or a drag that started on FIRE). */
  private look: { id: number; x: number; y: number } | null = null
  private lookX = 0
  private lookY = 0
  /** The stick ring radius in CSS px, measured from the live base (size settings included). */
  private stickR = STICK_R
  /** FIRE is held by this pointer (auto-repeat runs in the game at the gun's rate). */
  private fireId = -1
  /** The sights are up (hold by default, or a toggle in the settings). */
  ads = false
  private adsDown = false
  private adsMode: 'hold' | 'toggle' = 'hold'
  private autoSprint = true
  private leftHanded = false
  private readonly off: (() => void)[] = []

  constructor(parent: HTMLElement) {
    this.layer = el('fr-touch fr-ui', parent)
    this.leftBase = el('fr-stick fr-stick-l', this.layer)
    this.leftKnob = el('fr-knob', this.leftBase)
    this.rightBase = el('fr-stick fr-stick-r', this.layer)
    this.rightKnob = el('fr-knob', this.rightBase)
    const pad = el('fr-pad', this.layer)
    const btn = (cls: string, label: string, bit: number, parentEl: HTMLElement = pad) => {
      const contextual = cls.includes('fr-btn-act')
      const b = el(`fr-btn fr-hit ${cls}`, parentEl, label)
      b.setAttribute('role', 'button')
      b.setAttribute('aria-label', label)
      const down = (e: PointerEvent) => {
        e.preventDefault()
        e.stopPropagation()
        this.active = true
        this.latched |= bit | (contextual ? this.actionBit : 0)
        b.classList.add('down')
      }
      const up = () => b.classList.remove('down')
      b.addEventListener('pointerdown', down)
      b.addEventListener('pointerup', up)
      b.addEventListener('pointercancel', up)
      b.addEventListener('pointerleave', up)
      return b
    }
    btn('fr-btn-roll fr-top-only', 'ROLL', BTN_ROLL)
    this.crouchBtn = btn('fr-btn-crouch fr-shooter-only', 'CROUCH', CROUCH_TAP)
    this.crouchBtn.setAttribute('aria-pressed', 'false')
    btn('fr-btn-reload', 'RELOAD', BTN_RELOAD)
    btn('fr-btn-jump', 'JUMP', JUMP_BIT)
    this.throwBtn = btn('fr-btn-throw', 'THROW', BTN_THROW)
    this.throwBtn.hidden = true
    this.action = btn('fr-btn-act', '', 0)
    this.action.hidden = true
    // a sprint button for players who don't want auto-sprint
    this.sprintBtn = btn('fr-btn-sprint fr-shooter-only', 'SPRINT', 0)
    this.sprintBtn.setAttribute('aria-label', 'Sprint')
    this.sprintBtn.addEventListener('pointerdown', () => {
      this.sprintHeld = true
    })
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      this.sprintBtn.addEventListener(type, () => {
        this.sprintHeld = false
      })
    }
    // the shooter's big two: FIRE (hold to keep firing, drag to track) and AIM
    const fire = el('fr-fire-pad fr-shooter-only', this.layer)
    this.fireBtn = el('fr-btn fr-hit fr-btn-fire', fire, 'FIRE')
    this.fireBtn.setAttribute('role', 'button')
    this.fireBtn.setAttribute('aria-label', 'Fire')
    this.adsBtn = el('fr-btn fr-hit fr-btn-ads', fire, 'AIM')
    this.adsBtn.setAttribute('role', 'button')
    this.adsBtn.setAttribute('aria-label', 'Aim down the sights')
    this.adsBtn.setAttribute('aria-pressed', 'false')
    this.wireFire(this.fireBtn)
    this.wireAds()

    const opts = { passive: false } as const
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      this.layer.addEventListener(type, fn as EventListener, opts)
      this.off.push(() => this.layer.removeEventListener(type, fn as EventListener))
    }
    listen('pointerdown', (e) => this.down(e))
    // a rotation, a fold or a resize: no stick keeps an origin from the old layout
    const relayout = () => {
      this.release()
      this.measureStick()
    }
    globalThis.addEventListener('resize', relayout)
    this.off.push(() => globalThis.removeEventListener('resize', relayout))
    // a gamepad takes over: the thumbs layer steps aside until it's gone
    const padSwap = () => {
      const any =
        typeof navigator.getGamepads === 'function' && navigator.getGamepads().some(Boolean)
      this.layer.classList.toggle('pad', any)
    }
    globalThis.addEventListener('gamepadconnected', padSwap)
    globalThis.addEventListener('gamepaddisconnected', padSwap)
    this.off.push(() => {
      globalThis.removeEventListener('gamepadconnected', padSwap)
      globalThis.removeEventListener('gamepaddisconnected', padSwap)
    })
    listen('pointermove', (e) => this.move(e))
    listen('pointerup', (e) => this.up(e))
    listen('pointercancel', (e) => this.up(e))
    this.place(this.rightBase, null)
  }

  /**
   * Apply the player's control settings: layout side, sizes, aim mode, auto-sprint. Cheap enough
   * to call on every settings change and on a view switch.
   */
  configure(s: FrontierSettings): void {
    if (s.leftHanded !== this.leftHanded) {
      this.leftHanded = s.leftHanded
      this.release()
    }
    this.adsMode = s.adsMode
    this.autoSprint = s.autoSprint
    const st = this.layer.style
    st.setProperty('--fr-user-ctl', String(s.controlScale))
    st.setProperty('--fr-user-joy', String(s.joyScale))
    this.layer.classList.toggle('lefty', s.leftHanded)
    // no separate sprint button when the stick does it
    this.layer.classList.toggle('show-sprint', !s.autoSprint)
    if (s.autoSprint) {
      this.sprintHeld = false
    }
    if (this.adsMode === 'toggle' && this.adsDown) {
      this.adsDown = false
    }
    this.measureStick()
  }

  /** A FIRE button: tap to shoot, hold to keep firing; a drag from it also looks. */
  private wireFire(b: HTMLElement): void {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.active = true
      this.fireId = e.pointerId
      this.latched |= BTN_FIRE
      b.classList.add('down')
      b.setPointerCapture(e.pointerId)
      // a drag from FIRE tracks the target while it fires
      if (!this.look) {
        this.look = { id: e.pointerId, x: e.clientX, y: e.clientY }
      }
    })
    b.addEventListener('pointermove', (e) => {
      // handled here, never again by the layer underneath
      e.stopPropagation()
      if (this.look?.id === e.pointerId) {
        e.preventDefault()
        this.lookMove(e)
      }
    })
    const up = (e: PointerEvent) => {
      e.stopPropagation()
      if (this.fireId === e.pointerId) {
        this.fireId = -1
        b.classList.remove('down')
      }
      if (this.look?.id === e.pointerId) {
        this.look = null
      }
    }
    b.addEventListener('pointerup', up)
    b.addEventListener('pointercancel', up)
  }

  /** AIM: hold (CODM's default) or toggle, per the settings. */
  private wireAds(): void {
    const b = this.adsBtn
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      b.setPointerCapture(e.pointerId)
      if (this.adsMode === 'toggle') {
        this.setAds(!this.ads)
        this.adsDown = false
      } else {
        this.adsDown = true
        this.setAds(true)
      }
    })
    const up = (e: PointerEvent) => {
      e.stopPropagation()
      if (this.adsMode === 'hold' && this.adsDown) {
        this.adsDown = false
        this.setAds(false)
      }
    }
    b.addEventListener('pointerup', up)
    b.addEventListener('pointercancel', up)
  }

  /** Shooter layout on or off (the view mode decides). */
  setShooter(on: boolean): void {
    this.shooter = on
    this.layer.classList.toggle('shooter', on)
    this.layer.classList.toggle('lefty', this.leftHanded)
    if (!on) {
      this.setAds(false)
    }
    this.left = null
    this.right = null
    this.look = null
    this.sprintHeld = false
    this.setSprint(false)
    this.place(this.leftBase, null)
    this.place(this.rightBase, null)
    this.measureStick()
  }

  setAds(on: boolean): void {
    this.ads = on
    this.adsBtn.classList.toggle('down', on)
    this.adsBtn.setAttribute('aria-pressed', String(on))
  }

  /** The crouch toggle shows pressed while you're crouched. */
  setCrouched(on: boolean): void {
    if (this.crouchBtn.classList.contains('on') !== on) {
      this.crouchBtn.classList.toggle('on', on)
      this.crouchBtn.setAttribute('aria-pressed', String(on))
    }
  }

  /** Dead or in a card: dim the thumbs and stop them taking input. */
  setEnabled(on: boolean): void {
    if (this.enabled === on) {
      return
    }
    this.enabled = on
    this.layer.classList.toggle('off', !on)
    if (!on) {
      this.release()
    }
  }

  /** FIRE is held right now (the game repeats the shot at the gun's rate). */
  get fireHeld(): boolean {
    return this.fireId >= 0
  }

  /** The THROW button shows only while you hold dynamite. */
  setThrow(on: boolean): void {
    if (this.throwBtn.hidden === on) {
      this.throwBtn.hidden = !on
    }
  }

  /** The contextual button: what it does and what it says (null hides it). */
  setAction(bit: number, label: string | null): void {
    this.actionBit = bit
    if (label === null) {
      this.action.hidden = true
      return
    }
    this.action.hidden = false
    if (this.action.textContent !== label) {
      this.action.textContent = label
    }
  }

  /** The movement zone: the left 45% (mirrored for a left-handed layout). */
  private inMoveZone(e: PointerEvent): boolean {
    const w = window.innerWidth
    const h = window.innerHeight
    const x = this.leftHanded ? w - e.clientX : e.clientX
    const tablet = document.documentElement.dataset.owForm === 'tablet'
    if (tablet) {
      return x < w * 0.4 && e.clientY > h * 0.25
    }
    // the thumb's half, below the HUD: a tap on the purse or the map never starts a ride
    return x < w * 0.45 && e.clientY > h * 0.22
  }

  /** The stick's home, in client px: the visible base at the bottom corner. */
  private home(base: HTMLElement): { x: number; y: number; r: number } {
    const r = base.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 }
  }

  /** Re-read the ring size after a settings or layout change. */
  private measureStick(): void {
    const w = this.leftBase.getBoundingClientRect().width
    this.stickR = w > 0 ? w / 2 : STICK_R
  }

  private down(e: PointerEvent): void {
    if (e.pointerType === 'mouse') {
      return
    }
    e.preventDefault()
    this.active = true
    this.layer.classList.add('on')
    this.layer.setPointerCapture(e.pointerId)
    if (this.inMoveZone(e) && !this.left) {
      const h = this.home(this.leftBase)
      this.stickR = h.r
      this.left = {
        id: e.pointerId,
        ox: h.x,
        oy: h.y,
        x: e.clientX,
        y: e.clientY,
        t0: performance.now(),
        moved: false,
        base: this.leftBase,
        knob: this.leftKnob,
      }
      this.place(this.leftBase, this.left)
    } else if (!this.inMoveZone(e) && this.shooter) {
      if (!this.look) {
        this.look = { id: e.pointerId, x: e.clientX, y: e.clientY }
      }
    } else if (!(this.right || this.shooter)) {
      const h = this.home(this.rightBase)
      this.stickR = h.r
      this.right = {
        id: e.pointerId,
        ox: e.clientX,
        oy: e.clientY,
        x: e.clientX,
        y: e.clientY,
        t0: performance.now(),
        moved: false,
        base: this.rightBase,
        knob: this.rightKnob,
      }
      this.place(this.rightBase, this.right)
    }
  }

  private lookMove(e: PointerEvent): void {
    const l = this.look
    if (!l) {
      return
    }
    // Coalesced events: at 120 Hz touch sampling, the intermediate points make a fast flick
    // follow the thumb instead of jumping to where it landed on the next frame.
    const events = e.getCoalescedEvents?.() ?? []
    if (events.length > 0) {
      for (const c of events) {
        this.lookX += c.clientX - l.x
        this.lookY += c.clientY - l.y
        l.x = c.clientX
        l.y = c.clientY
      }
      return
    }
    this.lookX += e.clientX - l.x
    this.lookY += e.clientY - l.y
    l.x = e.clientX
    l.y = e.clientY
  }

  private move(e: PointerEvent): void {
    if (this.look?.id === e.pointerId) {
      e.preventDefault()
      this.lookMove(e)
      return
    }
    const st = this.left?.id === e.pointerId ? this.left : this.right
    if (!st || st.id !== e.pointerId) {
      return
    }
    e.preventDefault()
    st.x = e.clientX
    st.y = e.clientY
    const dx = st.x - st.ox
    const dy = st.y - st.oy
    const r = this.radius()
    if (Math.hypot(dx, dy) > r * DEAD_FRAC) {
      st.moved = true
    }
    if (st === this.right && st.moved) {
      this.aim = Math.atan2(dy / PITCH_SIN, dx)
    }
    this.knobAt(st)
  }

  private up(e: PointerEvent): void {
    if (this.look?.id === e.pointerId) {
      this.look = null
      return
    }
    if (this.left?.id === e.pointerId) {
      this.left = null
      this.place(this.leftBase, null)
      this.setSprint(false)
      return
    }
    const r = this.right
    if (r?.id !== e.pointerId) {
      return
    }
    const tap = !r.moved && performance.now() - r.t0 < TAP_MS
    if (r.moved || tap) {
      // Flick-to-fire: the release is the shot (still aimed, for the Dead-Eye window).
      this.latched |= BTN_FIRE
      this.aimHold = r.moved ? BTN_AIM : 0
    }
    this.right = null
    this.place(this.rightBase, null)
  }

  /** The stick ring in CSS px at the current size setting. */
  private radius(): number {
    return this.stickR
  }

  private place(base: HTMLElement, st: Stick | null): void {
    if (st) {
      if (base === this.rightBase) {
        base.style.transform = `translate(${st.ox - this.radius()}px, ${st.oy - this.radius()}px)`
      }
      base.classList.add('live')
      this.knobAt(st)
      return
    }
    base.classList.remove('live')
    if (base === this.rightBase) {
      base.style.transform = ''
    }
    const knob = base.firstElementChild as HTMLElement | null
    if (knob) {
      knob.style.transform = ''
    }
  }

  private knobAt(st: Stick): void {
    let dx = st.x - st.ox
    let dy = st.y - st.oy
    const r = this.radius()
    const d = Math.hypot(dx, dy)
    if (d > r) {
      dx = (dx / d) * r
      dy = (dy / d) * r
    }
    st.knob.style.transform = `translate(${dx}px, ${dy}px)`
  }

  /** Top-down: true while the right stick is held and aimed (the reticle and the aim line show). */
  get aiming(): boolean {
    if (this.shooter) {
      return false
    }
    return (
      this.right?.moved === true ||
      (this.right !== null && performance.now() - this.right.t0 > TAP_MS)
    )
  }

  /** Look drag since the last call, CSS px. */
  takeLook(out: { x: number; y: number }): { x: number; y: number } {
    out.x = this.lookX
    out.y = this.lookY
    this.lookX = 0
    this.lookY = 0
    return out
  }

  /** A look finger is down (aim friction applies only while you're steering). */
  get looking(): boolean {
    return this.look !== null
  }

  sample(): Sampled {
    let mx = 0
    let mz = 0
    const l = this.left
    if (l) {
      const dx = l.x - l.ox
      const dy = l.y - l.oy
      const r = this.radius()
      const d = Math.hypot(dx, dy)
      const dead = r * DEAD_FRAC
      if (d > dead) {
        // rescale past the dead zone so the full ring is full speed, and ease the first few px
        const raw = Math.min(1, (d - dead) / (r - dead))
        const k = raw * raw * (3 - 2 * raw)
        mx = (dx / d) * k
        mz = (dy / d) * k
      }
      // auto-sprint: the thumb past the ring, toward the top of the screen (hysteresis back)
      const up = d > 0 ? -dy / d : 0
      const reach = d / r
      if (this.autoSprint) {
        this.setSprint(up >= SPRINT_CONE && reach >= (this.sprint ? SPRINT_OFF : SPRINT_ON))
      } else {
        this.setSprint(false)
      }
    } else if (this.autoSprint) {
      this.setSprint(false)
    }
    let buttons = this.latched | this.aimHold | (this.sprint || this.sprintHeld ? BTN_SPRINT : 0)
    if (this.aiming || (this.shooter && this.ads)) {
      buttons |= BTN_AIM
    }
    this.latched = 0
    this.aimHold = 0
    return { mx, mz, buttons, aim: this.shooter ? null : this.aim, assist: true }
  }

  /** Let go of every stick and the look finger (a layout change). */
  release(): void {
    this.left = null
    this.right = null
    this.look = null
    this.fireId = -1
    this.sprintHeld = false
    this.adsDown = false
    this.setAds(false)
    this.place(this.leftBase, null)
    this.place(this.rightBase, null)
    this.setSprint(false)
  }

  private setSprint(on: boolean): void {
    if (on !== this.sprint) {
      this.sprint = on
      this.leftBase.classList.toggle('sprint', on)
    }
  }

  dispose(): void {
    for (const f of this.off) {
      f()
    }
    this.layer.remove()
  }
}
