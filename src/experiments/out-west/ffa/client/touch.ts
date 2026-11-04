// biome-ignore-all lint/style/useThisInClassMethods: private helpers kept on the class next to the state they describe
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: stick and button state is mutated from pointer callbacks; Biome narrows them to their initialisers
/**
 * Touch controls, as DOM in their own layer above the canvas so input never waits on WebGL (spec
 * §3.8). Two layouts:
 *
 * Shooter (over the shoulder / first person, the default):
 * - a floating move stick that spawns under the left thumb anywhere in the left 45%; push it past
 *   its ring toward the top of the screen to sprint (it glows while you do);
 * - drag anywhere else on the right to look (the game applies the sensitivity and, on touch only,
 *   a little aim friction and magnetism);
 * - FIRE: tap to shoot, hold to keep firing at the gun's own rate; dragging from FIRE also looks,
 *   so you can track while you shoot;
 * - a smaller FIRE on the left, for a thumb that's on the stick;
 * - AIM toggles the sights (from the holster it closes the Dead-Eye reticle), CROUCH (a toggle; a
 *   slide mid-sprint), JUMP, RELOAD, THROW while you hold dynamite, and the contextual button
 *   (BANK, SHIP, OPEN, ACCEPT, CALL OUT).
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

const STICK_R = 56
/** Sprint: the thumb past this far (× the ring), within `SPRINT_CONE` of straight up; off under `SPRINT_OFF`. */
const SPRINT_ON = 1.15
const SPRINT_OFF = 0.8
const SPRINT_CONE = Math.cos((40 * Math.PI) / 180)
const DEAD_PX = 10
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
  private readonly fireLeft: HTMLElement
  private readonly crouchBtn: HTMLElement
  /** The left stick is past the ring, forward: sprinting. */
  private sprint = false
  private actionBit = 0
  private latched = 0
  /** BTN_AIM kept for the release frame so a Dead-Eye release still counts as aimed. */
  private aimHold = 0
  private aim: number | null = null
  active = false
  /** Shooter layout (look by drag, FIRE / AIM buttons) or the top-down twin-stick. */
  private shooter = false
  /** The look finger (right side, or a drag that started on FIRE). */
  private look: { id: number; x: number; y: number } | null = null
  private lookX = 0
  private lookY = 0
  /** FIRE is held by this pointer (auto-repeat runs in the game at the gun's rate). */
  private fireId = -1
  /** The sights are up (AIM is a toggle on touch). */
  ads = false
  private readonly off: (() => void)[] = []

  constructor(parent: HTMLElement) {
    this.layer = el('fr-touch fr-ui', parent)
    this.leftBase = el('fr-stick fr-stick-l', this.layer)
    this.leftKnob = el('fr-knob', this.leftBase)
    this.rightBase = el('fr-stick fr-stick-r', this.layer)
    this.rightKnob = el('fr-knob', this.rightBase)
    const pad = el('fr-pad', this.layer)
    const btn = (cls: string, label: string, bit: number, parentEl: HTMLElement = pad) => {
      const b = el(`fr-btn fr-hit ${cls}`, parentEl, label)
      b.setAttribute('role', 'button')
      b.setAttribute('aria-label', label)
      const down = (e: PointerEvent) => {
        e.preventDefault()
        e.stopPropagation()
        this.latched |= bit || this.actionBit
        b.classList.add('down')
      }
      const up = () => b.classList.remove('down')
      b.addEventListener('pointerdown', down)
      b.addEventListener('pointerup', up)
      b.addEventListener('pointercancel', up)
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
    // the shooter's big two: FIRE (hold to keep firing, drag to track) and AIM (a toggle)
    const fire = el('fr-fire-pad fr-shooter-only', this.layer)
    this.fireBtn = el('fr-btn fr-hit fr-btn-fire', fire, 'FIRE')
    this.fireBtn.setAttribute('role', 'button')
    this.fireBtn.setAttribute('aria-label', 'Fire')
    this.fireLeft = el('fr-btn fr-hit fr-btn-fire fr-btn-fire-l', fire, 'FIRE')
    this.fireLeft.setAttribute('role', 'button')
    this.fireLeft.setAttribute('aria-label', 'Fire (left thumb)')
    this.adsBtn = el('fr-btn fr-hit fr-btn-ads', fire, 'AIM')
    this.adsBtn.setAttribute('role', 'button')
    this.adsBtn.setAttribute('aria-label', 'Aim down the sights')
    this.adsBtn.setAttribute('aria-pressed', 'false')
    this.wireFire(this.fireBtn, true)
    this.wireFire(this.fireLeft, false)
    this.adsBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.setAds(!this.ads)
    })

    const opts = { passive: false } as const
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      this.layer.addEventListener(type, fn as EventListener, opts)
      this.off.push(() => this.layer.removeEventListener(type, fn as EventListener))
    }
    listen('pointerdown', (e) => this.down(e))
    listen('pointermove', (e) => this.move(e))
    listen('pointerup', (e) => this.up(e))
    listen('pointercancel', (e) => this.up(e))
    this.place(this.rightBase, null)
  }

  /** A FIRE button: tap to shoot, hold to keep firing; `look`: a drag from it also looks. */
  private wireFire(b: HTMLElement, look: boolean): void {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.active = true
      this.fireId = e.pointerId
      this.latched |= BTN_FIRE
      b.classList.add('down')
      b.setPointerCapture(e.pointerId)
      // a drag from FIRE tracks the target while it fires
      if (look && !this.look) {
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

  /** Shooter layout on or off (the view mode decides). */
  setShooter(on: boolean): void {
    this.shooter = on
    this.layer.classList.toggle('shooter', on)
    if (!on) {
      this.setAds(false)
    }
    this.left = null
    this.right = null
    this.look = null
    this.place(this.leftBase, null)
    this.place(this.rightBase, null)
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

  private down(e: PointerEvent): void {
    if (e.pointerType === 'mouse') {
      return
    }
    e.preventDefault()
    this.active = true
    this.layer.classList.add('on')
    this.layer.setPointerCapture(e.pointerId)
    const w = window.innerWidth
    const s: Omit<Stick, 'base' | 'knob'> = {
      id: e.pointerId,
      ox: e.clientX,
      oy: e.clientY,
      x: e.clientX,
      y: e.clientY,
      t0: performance.now(),
      moved: false,
    }
    if (e.clientX < w * 0.45) {
      if (!this.left) {
        this.left = { ...s, base: this.leftBase, knob: this.leftKnob }
        this.place(this.leftBase, this.left)
      }
    } else if (this.shooter) {
      if (!this.look) {
        this.look = { id: e.pointerId, x: e.clientX, y: e.clientY }
      }
    } else if (!this.right) {
      this.right = { ...s, base: this.rightBase, knob: this.rightKnob }
      this.place(this.rightBase, this.right)
    }
  }

  private lookMove(e: PointerEvent): void {
    const l = this.look
    if (!l) {
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
    if (Math.hypot(dx, dy) > DEAD_PX) {
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

  private place(base: HTMLElement, st: Stick | null): void {
    if (st) {
      base.style.transform = `translate(${st.ox - STICK_R}px, ${st.oy - STICK_R}px)`
      base.classList.add('live')
      this.knobAt(st)
      return
    }
    base.classList.remove('live')
    base.style.transform = ''
    const knob = base.firstElementChild as HTMLElement | null
    if (knob) {
      knob.style.transform = ''
    }
  }

  private knobAt(st: Stick): void {
    let dx = st.x - st.ox
    let dy = st.y - st.oy
    const d = Math.hypot(dx, dy)
    if (d > STICK_R) {
      dx = (dx / d) * STICK_R
      dy = (dy / d) * STICK_R
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
      const d = Math.hypot(dx, dy)
      if (d > DEAD_PX) {
        const k = Math.min(1, d / STICK_R) / d
        mx = dx * k
        mz = dy * k
      }
      // sprint: past the ring, toward the top of the screen (hysteresis on the way back)
      const up = d > 0 ? -dy / d : 0
      const reach = d / STICK_R
      this.setSprint(
        this.shooter && up >= SPRINT_CONE && reach >= (this.sprint ? SPRINT_OFF : SPRINT_ON),
      )
    }
    let buttons = this.latched | this.aimHold | (this.sprint ? BTN_SPRINT : 0)
    if (this.aiming || (this.shooter && this.ads)) {
      buttons |= BTN_AIM
    }
    this.latched = 0
    this.aimHold = 0
    return { mx, mz, buttons, aim: this.shooter ? null : this.aim, assist: true }
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
