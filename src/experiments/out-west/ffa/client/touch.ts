// biome-ignore-all lint/style/useThisInClassMethods: private helpers kept on the class next to the state they describe
/**
 * Twin-stick touch controls, as DOM in their own layer above the canvas so input never waits on
 * WebGL (spec §3.1, §3.8). The left stick floats: it spawns under the thumb anywhere in the left
 * 45% of the screen. The right stick aims while dragged and fires on release (flick-to-fire);
 * holding it 400 ms from the holster closes the Dead-Eye reticle. Buttons: roll (above the right
 * stick), reload, and one contextual 64 px action (bank, open, accept, call out). Every target is
 * at least 56 CSS px.
 */
import { BTN_AIM, BTN_FIRE, BTN_RELOAD, BTN_ROLL, BTN_THROW } from '../../contract/town.ts'
import type { Sampled } from './controls.ts'

const STICK_R = 56
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
  private actionBit = 0
  private latched = 0
  /** BTN_AIM kept for the release frame so a Dead-Eye release still counts as aimed. */
  private aimHold = 0
  private aim: number | null = null
  active = false
  private readonly off: (() => void)[] = []

  constructor(parent: HTMLElement) {
    this.layer = el('fr-touch fr-ui', parent)
    this.leftBase = el('fr-stick fr-stick-l', this.layer)
    this.leftKnob = el('fr-knob', this.leftBase)
    this.rightBase = el('fr-stick fr-stick-r', this.layer)
    this.rightKnob = el('fr-knob', this.rightBase)
    const pad = el('fr-pad', this.layer)
    const btn = (cls: string, label: string, bit: number) => {
      const b = el(`fr-btn fr-hit ${cls}`, pad, label)
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
    btn('fr-btn-roll', 'ROLL', BTN_ROLL)
    btn('fr-btn-reload', 'RELOAD', BTN_RELOAD)
    this.throwBtn = btn('fr-btn-throw', 'THROW', BTN_THROW)
    this.throwBtn.hidden = true
    this.action = btn('fr-btn-act', '', 0)
    this.action.hidden = true

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
    } else if (!this.right) {
      this.right = { ...s, base: this.rightBase, knob: this.rightKnob }
      this.place(this.rightBase, this.right)
    }
  }

  private move(e: PointerEvent): void {
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
    if (this.left?.id === e.pointerId) {
      this.left = null
      this.place(this.leftBase, null)
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

  /** True while the right stick is held and aimed (the reticle and the aim line show). */
  get aiming(): boolean {
    return (
      this.right?.moved === true ||
      (this.right !== null && performance.now() - this.right.t0 > TAP_MS)
    )
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
    }
    let buttons = this.latched | this.aimHold
    if (this.aiming) {
      buttons |= BTN_AIM
    }
    this.latched = 0
    this.aimHold = 0
    return { mx, mz, buttons, aim: this.aim, assist: true }
  }

  dispose(): void {
    for (const f of this.off) {
      f()
    }
    this.layer.remove()
  }
}
