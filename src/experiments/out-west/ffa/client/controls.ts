// biome-ignore-all lint/suspicious/noUnnecessaryConditions: input flags are mutated from DOM and gamepad callbacks; Biome narrows them to their initialisers
/**
 * Desktop and gamepad input → one held-button word, a move vector and an aim. Presses shorter
 * than a 50 ms tick are latched so the server always sees their edge.
 *
 * Desktop: WASD/arrows move, the mouse aims, LMB fires, hold RMB for Dead-Eye, Space rolls,
 * R reloads, E banks/opens/accepts, Q calls out. Gamepad: sticks, RT fire, LT Dead-Eye, A roll,
 * X reload, B interact, Y call out.
 */
import {
  BTN_AIM,
  BTN_CALLOUT,
  BTN_FIRE,
  BTN_INTERACT,
  BTN_RELOAD,
  BTN_ROLL,
} from '../../contract/town.ts'

export interface Sampled {
  /** −1..1 each, +x east, +z south. */
  mx: number
  mz: number
  buttons: number
  /** Aim in radians when the device supplies one directly (stick); null to use the pointer. */
  aim: number | null
  /** Light aim assist applies (touch and gamepad). */
  assist: boolean
}

const KEY_BUTTONS: Record<string, number> = {
  Space: BTN_ROLL,
  KeyR: BTN_RELOAD,
  KeyE: BTN_INTERACT,
  KeyF: BTN_INTERACT,
  KeyQ: BTN_CALLOUT,
}

const PAD_BUTTONS: readonly (readonly [number, number])[] = [
  [7, BTN_FIRE],
  [6, BTN_AIM],
  [0, BTN_ROLL],
  [2, BTN_RELOAD],
  [1, BTN_INTERACT],
  [3, BTN_CALLOUT],
]

const PAD_DEAD = 0.18

export class DesktopControls {
  private readonly keys = new Set<string>()
  private held = 0
  private latched = 0
  /** Pointer position in client pixels, once the mouse has moved over the game. */
  readonly pointer = { x: 0, y: 0, has: false }
  private padAim: number | null = null
  usingPad = false
  private readonly root: HTMLElement
  private readonly off: (() => void)[] = []

  constructor(root: HTMLElement) {
    this.root = root
    const on = <K extends keyof WindowEventMap>(
      type: K,
      fn: (e: WindowEventMap[K]) => void,
      target: Window | HTMLElement = globalThis as unknown as Window,
    ) => {
      target.addEventListener(type, fn as EventListener, { passive: false })
      this.off.push(() => target.removeEventListener(type, fn as EventListener))
    }
    on('keydown', (e) => this.key(e, true))
    on('keyup', (e) => this.key(e, false))
    on('blur', () => {
      this.keys.clear()
      this.held = 0
    })
    on(
      'pointermove',
      (e) => {
        if (e.pointerType === 'mouse') {
          this.pointer.x = e.clientX
          this.pointer.y = e.clientY
          this.pointer.has = true
          this.usingPad = false
        }
      },
      root,
    )
    on(
      'pointerdown',
      (e) => {
        if (e.pointerType !== 'mouse' || (e.target as HTMLElement).closest('.fr-hit')) {
          return
        }
        e.preventDefault()
        const bit = e.button === 2 ? BTN_AIM : BTN_FIRE
        this.press(bit)
      },
      root,
    )
    on(
      'pointerup',
      (e) => {
        if (e.pointerType === 'mouse') {
          this.release(e.button === 2 ? BTN_AIM : BTN_FIRE)
        }
      },
      root,
    )
    on('contextmenu', (e) => e.preventDefault(), root)
  }

  private press(bit: number): void {
    this.held |= bit
    this.latched |= bit
  }

  private release(bit: number): void {
    this.held &= ~bit
  }

  private key(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
      return
    }
    if (down) {
      this.keys.add(e.code)
    } else {
      this.keys.delete(e.code)
    }
    const bit = KEY_BUTTONS[e.code]
    if (bit !== undefined) {
      e.preventDefault()
      if (down && !e.repeat) {
        this.press(bit)
      } else if (!down) {
        this.release(bit)
      }
    }
    if (e.code.startsWith('Arrow')) {
      e.preventDefault()
    }
  }

  /** RMB / LT held (the Dead-Eye reticle shows). */
  get aimHeld(): boolean {
    return (this.held & BTN_AIM) !== 0 || (this.padHeld & BTN_AIM) !== 0
  }

  /** Inject a one-tick press (HUD buttons, menu actions). */
  tap(bit: number): void {
    this.latched |= bit
  }

  sample(): Sampled {
    const k = this.keys
    let mx =
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
    let mz =
      (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0)
    let buttons = this.held | this.latched
    this.latched = 0
    const pad = this.pad()
    if (pad) {
      if (Math.abs(pad.mx) + Math.abs(pad.mz) > 0) {
        mx = pad.mx
        mz = pad.mz
      }
      buttons |= pad.buttons
    }
    const len = Math.hypot(mx, mz)
    if (len > 1) {
      mx /= len
      mz /= len
    }
    return { mx, mz, buttons, aim: this.usingPad ? this.padAim : null, assist: this.usingPad }
  }

  private padHeld = 0

  private pad(): { mx: number; mz: number; buttons: number } | null {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : []
    const p = pads.find((g) => g?.connected)
    if (!p) {
      return null
    }
    const ax = (i: number) => {
      const v = p.axes[i] ?? 0
      return Math.abs(v) < PAD_DEAD ? 0 : v
    }
    let held = 0
    for (const [i, bit] of PAD_BUTTONS) {
      const b = p.buttons[i]
      if (b && (b.pressed || b.value > 0.4)) {
        held |= bit
      }
    }
    const rx = ax(2)
    const rz = ax(3)
    if (Math.hypot(rx, rz) > 0.35) {
      this.padAim = Math.atan2(rz, rx)
      this.usingPad = true
    }
    const lx = ax(0)
    const lz = ax(1)
    if (held || lx || lz) {
      this.usingPad = true
    }
    const rising = held & ~this.padHeld
    this.padHeld = held
    return { mx: lx, mz: lz, buttons: held | rising }
  }

  dispose(): void {
    for (const f of this.off) {
      f()
    }
    this.off.length = 0
    this.root.blur()
  }
}
