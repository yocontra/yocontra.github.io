// biome-ignore-all lint/suspicious/noUnnecessaryConditions: input flags are mutated from DOM and gamepad callbacks; Biome narrows them to their initialisers
/**
 * Desktop and gamepad input → one held-button word, a move vector, and either an aim (top-down) or
 * look deltas (over the shoulder / first person). Presses shorter than a 50 ms tick are latched so
 * the server always sees their edge. The key table lives in `bindings.ts`.
 *
 * Shooter views: the first click on the game takes the pointer lock (and doesn't fire); then the
 * mouse looks, LMB fires and RMB aims down the sights. Losing the lock (Esc, alt-tab) tells the
 * game, which opens the pause menu. Gamepad, the CoD layout: left stick moves (click it to sprint
 * until the stick returns), right stick looks, RT fire, LT aim, A jump, B crouch (slide
 * mid-sprint), X reload, Y interact, RB throw, LB call out.
 *
 * Top-down: WASD/arrows move, the mouse aims at the ground, LMB fires, hold RMB for Dead-Eye.
 */
import {
  BTN_AIM,
  BTN_CALLOUT,
  BTN_FIRE,
  BTN_RELOAD,
  BTN_ROLL,
  BTN_SPRINT,
  BTN_THROW,
} from '../../contract/town.ts'
import {
  CROUCH_TAP,
  JUMP_BIT,
  KEY_SCOREBOARD,
  KEY_SHOULDER,
  KEY_VIEW_TOGGLE,
  SHOOTER_KEYS,
  TOP_KEYS,
} from './bindings.ts'

export interface Sampled {
  /** −1..1 each. Top-down: +x east, +z south. Shooter: +x right, +z back (screen terms). */
  mx: number
  mz: number
  buttons: number
  /** Aim in radians when the device supplies one directly (stick); null to use the pointer. */
  aim: number | null
  /** Light aim assist applies (touch and gamepad). */
  assist: boolean
}

export interface DesktopHooks {
  /** V: swap first and third person. */
  onViewToggle: () => void
  /** X: swap the shoulder. */
  onShoulder: () => void
  /** Tab held / released. */
  onScoreboard: (open: boolean) => void
  /** The pointer lock was lost while playing (Esc, alt-tab, a system dialog). */
  onLockLost: () => void
}

const PAD_TOP: readonly (readonly [number, number])[] = [
  [7, BTN_FIRE],
  [6, BTN_AIM],
  [0, JUMP_BIT],
  [4, BTN_ROLL],
  [2, BTN_RELOAD],
  [1, BTN_CALLOUT],
  [3, BTN_CALLOUT],
  [5, BTN_THROW],
]

const PAD_SHOOTER: readonly (readonly [number, number])[] = [
  [7, BTN_FIRE],
  [6, BTN_AIM],
  [0, JUMP_BIT],
  [1, CROUCH_TAP],
  [2, BTN_RELOAD],
  [3, BTN_CALLOUT],
  [4, BTN_CALLOUT],
  [5, BTN_THROW],
]

const PAD_DEAD = 0.18
/** Right stick at full tilt turns this fast (rad/s) before the sensitivity setting. */
const PAD_LOOK_RATE = 3.2
/** A single mouse event never moves more than this (Chrome's occasional pointer-lock spikes). */
const MAX_MOUSE_STEP = 240

export class DesktopControls {
  private readonly keys = new Set<string>()
  private held = 0
  private latched = 0
  /** Pointer position in client pixels, once the mouse has moved over the game. */
  readonly pointer = { x: 0, y: 0, has: false }
  private padAim: number | null = null
  usingPad = false
  /** Over the shoulder or first person: mouse-look under pointer lock. */
  private shooter = false
  /** Accumulated look since the last `takeLook`, px (mouse) or px-equivalent (right stick). */
  private lookX = 0
  private lookY = 0
  /** The game wants input (not paused, not dead in a menu): a click may take the lock. */
  enabled = true
  /** RMB toggles the sights instead of holding them (a setting). */
  adsToggle = false
  /** The sights, when RMB is a toggle. */
  private adsOn = false
  /** Gamepad: L3 clicked, sprinting until the left stick comes back to centre. */
  private padSprint = false
  private readonly root: HTMLElement
  private readonly hooks: DesktopHooks | null
  private readonly off: (() => void)[] = []
  private lastPad = 0

  constructor(root: HTMLElement, hooks: DesktopHooks | null = null) {
    this.root = root
    this.hooks = hooks
    const on = <K extends keyof WindowEventMap | 'pointerlockchange'>(
      type: K,
      fn: (e: K extends keyof WindowEventMap ? WindowEventMap[K] : Event) => void,
      target: Window | HTMLElement | Document = globalThis as unknown as Window,
    ) => {
      target.addEventListener(type, fn as EventListener, { passive: false })
      this.off.push(() => target.removeEventListener(type, fn as EventListener))
    }
    on('keydown', (e) => this.key(e, true))
    on('keyup', (e) => this.key(e, false))
    on('blur', () => {
      this.keys.clear()
      this.held = 0
      this.hooks?.onScoreboard(false)
    })
    on('pointermove', (e) => this.move(e), root)
    on('pointerdown', (e) => this.down(e), root)
    on(
      'pointerup',
      (e) => {
        if (e.pointerType === 'mouse' && !(e.button === 2 && this.adsToggle)) {
          this.release(e.button === 2 ? BTN_AIM : BTN_FIRE)
        }
      },
      root,
    )
    on('contextmenu', (e) => e.preventDefault(), root)
    on(
      'pointerlockchange',
      () => {
        if (!this.locked) {
          // the lock went away (Esc, alt-tab): let go of everything held under it
          this.held = 0
          this.adsOn = false
          if (this.shooter && this.enabled) {
            this.hooks?.onLockLost()
          }
        }
      },
      document,
    )
  }

  /** Switch between mouse-look (shooter views) and pointer aim (top-down). */
  setShooter(on: boolean): void {
    this.shooter = on
    if (!on) {
      this.unlock()
    }
  }

  get locked(): boolean {
    return document.pointerLockElement === this.root
  }

  /** Take the pointer (must run inside a user gesture, such as a click). */
  lock(): void {
    if (!this.shooter || this.locked || typeof this.root.requestPointerLock !== 'function') {
      return
    }
    // raw mouse deltas where supported (no OS acceleration); a plain lock otherwise
    this.requestLock({ unadjustedMovement: true }).catch(() => this.requestLock())
  }

  private async requestLock(opts?: { unadjustedMovement: boolean }): Promise<void> {
    try {
      await (this.root.requestPointerLock(opts) as Promise<void> | undefined)
    } catch (e) {
      if (opts) {
        throw e
      }
      // Chrome refuses a re-lock for about a second after Esc: the next click retries.
    }
  }

  unlock(): void {
    if (this.locked) {
      document.exitPointerLock()
    }
  }

  private move(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') {
      return
    }
    this.pointer.x = e.clientX
    this.pointer.y = e.clientY
    this.pointer.has = true
    this.usingPad = false
    if (this.shooter && this.locked) {
      const clamp = (v: number) => Math.max(-MAX_MOUSE_STEP, Math.min(MAX_MOUSE_STEP, v))
      this.lookX += clamp(e.movementX)
      this.lookY += clamp(e.movementY)
    }
  }

  private down(e: PointerEvent): void {
    if (e.pointerType !== 'mouse' || (e.target as HTMLElement).closest('.fr-hit')) {
      return
    }
    e.preventDefault()
    if (this.shooter && !this.locked) {
      // the first click only takes the mouse; it never fires
      if (this.enabled) {
        this.lock()
      }
      return
    }
    if (e.button === 2 && this.adsToggle) {
      this.adsOn = !this.adsOn
      return
    }
    this.press(e.button === 2 ? BTN_AIM : BTN_FIRE)
  }

  /** Drop the sights (death, a menu, a view switch). */
  dropAds(): void {
    this.adsOn = false
    this.held &= ~BTN_AIM
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
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      return
    }
    if (down) {
      this.keys.add(e.code)
    } else {
      this.keys.delete(e.code)
    }
    if (e.code === KEY_SCOREBOARD) {
      if (!this.enabled) {
        // paused: Tab walks the menu's buttons as usual
        this.hooks?.onScoreboard(false)
        return
      }
      e.preventDefault()
      if (!e.repeat) {
        this.hooks?.onScoreboard(down)
      }
      return
    }
    if (down && !e.repeat && this.shooter && this.enabled) {
      if (e.code === KEY_VIEW_TOGGLE) {
        this.hooks?.onViewToggle()
      } else if (e.code === KEY_SHOULDER) {
        this.hooks?.onShoulder()
      }
    }
    const bit = (this.shooter ? SHOOTER_KEYS : TOP_KEYS)[e.code]
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

  /** RMB / LT held (aiming down the sights; the Dead-Eye reticle from the holster). */
  get aimHeld(): boolean {
    return this.adsOn || (this.held & BTN_AIM) !== 0 || (this.padHeld & BTN_AIM) !== 0
  }

  /** Inject a one-tick press (HUD buttons, menu actions). */
  tap(bit: number): void {
    this.latched |= bit
  }

  /** Look movement since the last call, in mouse pixels (the game applies the sensitivity). */
  takeLook(out: { x: number; y: number }): { x: number; y: number } {
    const now = performance.now()
    const dt = Math.min(0.1, (now - (this.lastPad || now)) / 1000)
    this.lastPad = now
    const pad = this.padLook
    if (pad.x !== 0 || pad.y !== 0) {
      // the stick is a rate: convert to mouse pixels at the default sensitivity
      this.lookX += (pad.x * PAD_LOOK_RATE * dt) / 0.0022
      this.lookY += (pad.y * PAD_LOOK_RATE * 0.7 * dt) / 0.0022
    }
    out.x = this.lookX
    out.y = this.lookY
    this.lookX = 0
    this.lookY = 0
    return out
  }

  /** Dev harness only: inject look as if the mouse moved. */
  injectLook(dx: number, dy: number): void {
    this.lookX += dx
    this.lookY += dy
  }

  sample(): Sampled {
    const k = this.keys
    let mx =
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
    let mz =
      (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0)
    let buttons = this.held | this.latched | (this.adsOn ? BTN_AIM : 0)
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
    const aim = this.usingPad && !this.shooter ? this.padAim : null
    return { mx, mz, buttons, aim, assist: this.usingPad }
  }

  private padHeld = 0
  private padL3 = false
  private readonly padLook = { x: 0, y: 0 }

  private pad(): { mx: number; mz: number; buttons: number } | null {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : []
    const p = pads.find((g) => g?.connected)
    this.padLook.x = 0
    this.padLook.y = 0
    if (!p) {
      return null
    }
    const ax = (i: number) => {
      const v = p.axes[i] ?? 0
      return Math.abs(v) < PAD_DEAD ? 0 : v
    }
    let held = 0
    for (const [i, bit] of this.shooter ? PAD_SHOOTER : PAD_TOP) {
      const b = p.buttons[i]
      if (b && (b.pressed || b.value > 0.4)) {
        held |= bit
      }
    }
    const rx = ax(2)
    const rz = ax(3)
    if (this.shooter) {
      // a squared response: fine aim near the centre, fast turns at full tilt
      this.padLook.x = rx * Math.abs(rx)
      this.padLook.y = rz * Math.abs(rz)
      if (rx || rz) {
        this.usingPad = true
      }
    } else if (Math.hypot(rx, rz) > 0.35) {
      this.padAim = Math.atan2(rz, rx)
      this.usingPad = true
    }
    const lx = ax(0)
    const lz = ax(1)
    if (held || lx || lz) {
      this.usingPad = true
    }
    // L3 (button 10): sprint until the stick comes back to centre
    const l3 = p.buttons[10]?.pressed === true
    if (l3 && !this.padL3) {
      this.padSprint = true
    }
    this.padL3 = l3
    if (Math.hypot(lx, lz) < 0.3) {
      this.padSprint = false
    }
    if (this.shooter && this.padSprint) {
      held |= BTN_SPRINT
    }
    const rising = held & ~this.padHeld
    this.padHeld = held
    return { mx: lx, mz: lz, buttons: held | rising }
  }

  dispose(): void {
    this.unlock()
    for (const f of this.off) {
      f()
    }
    this.off.length = 0
    this.root.blur()
  }
}
