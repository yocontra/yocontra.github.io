import {
  KEY_A,
  KEY_ALT,
  KEY_C,
  KEY_D,
  KEY_DOWN,
  KEY_E,
  KEY_G,
  KEY_LEFT,
  KEY_Q,
  KEY_R,
  KEY_RIGHT,
  KEY_S,
  KEY_SHIFT,
  KEY_SPACE,
  KEY_UP,
  KEY_W,
  Keyboard,
  MOUSEBUTTON_LEFT,
  MOUSEBUTTON_RIGHT,
  Mouse,
} from 'playcanvas'
import { type FrontierSettings, loadSettings } from '../ffa/client/settings.ts'
import { Buttons, type PlayerInput } from '../runtime/protocol.ts'

const SENSITIVITY = 0.0024
const TOUCH_SENSITIVITY = 0.006
const clampPitch = (angle: number): number => Math.max(-1.45, Math.min(1.45, angle))

/** Input samples contain intent only; cameras and physics consume them independently. */
export class GameInput {
  readonly keyboard: Keyboard
  readonly mouse: Mouse
  private settings = loadSettings()
  configure(settings: FrontierSettings): void {
    this.settings = settings
    this.controls.classList.toggle('left-handed', settings.leftHanded)
    this.controls.style.setProperty('--control-scale', String(settings.controlScale))
  }
  readonly cursor = { x: 0, y: 0 }
  cursorAim = true as boolean
  private lastTouchAt = Number.NEGATIVE_INFINITY
  yaw = 0
  pitch = -0.1
  private readonly abort = new AbortController()
  private readonly pointers = new Map<number, { x: number; y: number; kind: 'move' | 'look' }>()
  private adsLatched = false as boolean
  private touchX = 0
  private touchZ = 0
  private readonly held = new Map<number, number>()
  private readonly edges = new Map<number, number>()
  private readonly controls: HTMLElement
  private get enabled(): boolean {
    return !this.controls.inert
  }
  private readonly canvas: HTMLCanvasElement
  constructor(canvas: HTMLCanvasElement, parent: HTMLElement) {
    this.canvas = canvas
    this.keyboard = new Keyboard(document.body)
    this.mouse = new Mouse(canvas)
    this.controls = document.createElement('div')
    this.controls.className = 'pc-touch-controls'
    const movement = document.createElement('div')
    movement.className = 'pc-movement-hint'
    movement.textContent = 'MOVE'
    this.controls.append(movement)
    for (const [name, bit] of [
      ['USE', Buttons.interact],
      ['CALL', Buttons.callout],
      ['ROLL', Buttons.roll],
      ['THROW', Buttons.throw],
      ['JUMP', Buttons.jump],
      ['CROUCH', Buttons.crouch],
      ['RELOAD', Buttons.reload],
      ['AIM', Buttons.aim],
      ['FIRE', Buttons.fire],
    ] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = name
      button.className = name === 'FIRE' ? 'pc-control pc-fire' : 'pc-control'
      button.addEventListener(
        'pointerdown',
        (event) => {
          event.preventDefault()
          button.setPointerCapture(event.pointerId)
          if (bit === Buttons.aim && this.settings.adsMode === 'toggle') {
            this.adsLatched = !this.adsLatched
            button.classList.toggle('held', this.adsLatched)
            return
          }
          this.held.set(event.pointerId, bit)
          this.tap(bit)
          button.classList.add('held')
        },
        { signal: this.abort.signal },
      )
      const release = (event: PointerEvent): void => {
        this.held.delete(event.pointerId)
        if (!(bit === Buttons.aim && this.settings.adsMode === 'toggle')) {
          button.classList.remove('held')
        }
      }
      button.addEventListener('pointerup', release, { signal: this.abort.signal })
      button.addEventListener('pointercancel', release, { signal: this.abort.signal })
      this.controls.append(button)
    }
    parent.append(this.controls)
    this.mouse.on('mousemove', this.look)
    this.mouse.on('mousedown', this.mouseDown)
    this.keyboard.on('keydown', this.keyDown)
    canvas.addEventListener('pointerdown', this.down, { signal: this.abort.signal })
    canvas.addEventListener('pointermove', this.move, { signal: this.abort.signal })
    canvas.addEventListener('pointerup', this.up, { signal: this.abort.signal })
    canvas.addEventListener('pointercancel', this.up, { signal: this.abort.signal })
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), {
      signal: this.abort.signal,
    })
    window.addEventListener('blur', () => this.release(), { signal: this.abort.signal })
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.hidden) {
          this.release()
        }
      },
      { signal: this.abort.signal },
    )
  }
  tap(bit: number): void {
    this.edges.set(bit, performance.now() + 100)
  }
  private readonly mouseDown = (event: { button: number }): void => {
    if (this.enabled && event.button === MOUSEBUTTON_RIGHT && this.settings.adsToggle) {
      this.adsLatched = !this.adsLatched
    }
    if (
      this.enabled &&
      event.button === MOUSEBUTTON_LEFT &&
      (document.pointerLockElement === this.canvas || this.settings.view === 'top')
    ) {
      this.tap(Buttons.fire)
    }
  }
  private readonly keyDown = (event: { key: number }): void => {
    if (!this.enabled) {
      return
    }
    const bit = new Map([
      [KEY_SPACE, Buttons.jump],
      [KEY_R, Buttons.reload],
      [KEY_E, Buttons.interact],
      [KEY_Q, Buttons.callout],
      [KEY_G, Buttons.throw],
      [KEY_ALT, Buttons.roll],
    ]).get(event.key)
    if (bit) {
      this.tap(bit)
    }
  }
  private readonly look = (event: { dx: number; dy: number; x: number; y: number }): void => {
    // Browsers synthesize mouse events after a touch release; those must not steal stick aim.
    if (performance.now() - this.lastTouchAt < 500) {
      return
    }
    this.cursorAim = true
    this.cursor.x = event.x
    this.cursor.y = event.y
    if (!this.enabled || document.pointerLockElement !== this.canvas) {
      return
    }
    this.yaw -= event.dx * SENSITIVITY * this.settings.mouseSens
    this.pitch = clampPitch(
      this.pitch -
        event.dy * SENSITIVITY * this.settings.mouseSens * (this.settings.invertY ? -1 : 1),
    )
  }
  private readonly down = (event: PointerEvent): void => {
    if (!this.enabled) {
      return
    }
    if (event.pointerType === 'mouse') {
      if (this.settings.view === 'top') {
        return
      }
      if (document.pointerLockElement !== this.canvas) {
        void this.canvas.requestPointerLock()?.catch(() => undefined)
      }
      return
    }
    event.preventDefault()
    this.lastTouchAt = performance.now()
    this.cursorAim = false
    const box = this.canvas.getBoundingClientRect()
    const kind = (
      this.settings.leftHanded
        ? event.clientX > box.left + box.width * 0.55
        : event.clientX < box.left + box.width * 0.45
    )
      ? 'move'
      : 'look'
    if ([...this.pointers.values()].some((pointer) => pointer.kind === kind)) {
      return
    }
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, kind })
    this.canvas.setPointerCapture(event.pointerId)
  }
  private readonly move = (event: PointerEvent): void => {
    const origin = this.pointers.get(event.pointerId)
    if (!(origin && this.enabled)) {
      return
    }
    event.preventDefault()
    this.lastTouchAt = performance.now()
    if (origin.kind === 'move') {
      this.touchX = Math.max(
        -1,
        Math.min(1, (event.clientX - origin.x) / (60 * this.settings.joyScale)),
      )
      this.touchZ = Math.max(
        -1,
        Math.min(1, (event.clientY - origin.y) / (60 * this.settings.joyScale)),
      )
    } else {
      this.cursorAim = false
      if (this.settings.view === 'top') {
        const dx = event.clientX - origin.x
        const dz = event.clientY - origin.y
        if (Math.hypot(dx, dz) > 4) {
          this.yaw = Math.atan2(-dx, -dz)
        }
        return
      }
      const sensitivity =
        this.settings.touchSens *
        (this.actionButtons() & Buttons.aim ? this.settings.touchAdsSens : 1)
      this.yaw -= (event.clientX - origin.x) * TOUCH_SENSITIVITY * sensitivity
      this.pitch = clampPitch(
        this.pitch -
          (event.clientY - origin.y) *
            TOUCH_SENSITIVITY *
            sensitivity *
            (this.settings.invertY ? -1 : 1),
      )
      origin.x = event.clientX
      origin.y = event.clientY
    }
  }
  private readonly up = (event: PointerEvent): void => {
    if (event.pointerType !== 'mouse') {
      this.lastTouchAt = performance.now()
    }
    if (this.pointers.get(event.pointerId)?.kind === 'move') {
      this.touchX = 0
      this.touchZ = 0
    }
    this.pointers.delete(event.pointerId)
  }
  setEnabled(enabled: boolean): void {
    this.controls.inert = !enabled
    if (!enabled) {
      this.release()
    }
  }
  private release(): void {
    this.adsLatched = false
    this.pointers.clear()
    this.held.clear()
    this.edges.clear()
    this.touchX = 0
    this.touchZ = 0
    this.keyboard.detach()
    this.keyboard.attach(document.body)
    for (const control of this.controls.children) {
      control.classList.remove('held')
    }
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock()
    }
  }
  private actionButtons(): number {
    let buttons = this.adsLatched ? Buttons.aim : 0
    const now = performance.now()
    for (const [bit, until] of this.edges) {
      if (now < until) {
        buttons |= bit
      } else {
        this.edges.delete(bit)
      }
    }
    for (const bit of this.held.values()) {
      buttons |= bit
    }
    if (this.keyboard.isPressed(KEY_SPACE)) {
      buttons |= Buttons.jump
    }
    if (
      this.keyboard.isPressed(KEY_SHIFT) ||
      (this.settings.autoSprint && Math.hypot(this.touchX, this.touchZ) > 0.95)
    ) {
      buttons |= Buttons.sprint
    }
    if (this.keyboard.isPressed(KEY_C)) {
      buttons |= Buttons.crouch
    }
    if (this.keyboard.isPressed(KEY_R)) {
      buttons |= Buttons.reload
    }
    if (this.keyboard.isPressed(KEY_E)) {
      buttons |= Buttons.interact
    }
    if (this.keyboard.isPressed(KEY_Q)) {
      buttons |= Buttons.callout
    }
    if (this.keyboard.isPressed(KEY_ALT)) {
      buttons |= Buttons.roll
    }
    if (this.keyboard.isPressed(KEY_G)) {
      buttons |= Buttons.throw
    }
    if (document.pointerLockElement === this.canvas || this.settings.view === 'top') {
      if (this.mouse.isPressed(MOUSEBUTTON_LEFT)) {
        buttons |= Buttons.fire
      }
      if (!this.settings.adsToggle && this.mouse.isPressed(MOUSEBUTTON_RIGHT)) {
        buttons |= Buttons.aim
      }
    }
    return buttons
  }
  sample(seq: number, seconds = 1 / 60): PlayerInput {
    const key = (...keys: number[]): boolean => keys.some((code) => this.keyboard.isPressed(code))
    if (!this.enabled) {
      return { seq, moveX: 0, moveZ: 0, yaw: this.yaw, pitch: this.pitch, buttons: 0 }
    }
    let x = this.touchX + Number(key(KEY_D, KEY_RIGHT)) - Number(key(KEY_A, KEY_LEFT))
    let z = this.touchZ + Number(key(KEY_S, KEY_DOWN)) - Number(key(KEY_W, KEY_UP))
    let buttons = this.actionButtons()
    const gamepad = navigator.getGamepads?.().find((pad) => pad?.connected)
    if (gamepad) {
      const axis = (index: number): number => {
        const value = gamepad.axes[index] ?? 0
        return Math.abs(value) > 0.15 ? value : 0
      }
      x += axis(0)
      z += axis(1)
      const rx = axis(2)
      const ry = axis(3)
      if (rx || ry) {
        this.cursorAim = false
        if (this.settings.view === 'top') {
          this.yaw = Math.atan2(-rx, -ry)
        } else {
          const dt = Math.min(0.1, Math.max(0, seconds))
          this.yaw -= rx * 4.5 * dt
          this.pitch = clampPitch(this.pitch - ry * 3 * dt * (this.settings.invertY ? -1 : 1))
        }
      }
      if (gamepad.buttons[0]?.pressed) {
        buttons |= Buttons.jump
      }
      if (gamepad.buttons[6]?.pressed) {
        buttons |= Buttons.aim
      }
      if (gamepad.buttons[7]?.pressed) {
        buttons |= Buttons.fire
      }
      if (gamepad.buttons[2]?.pressed) {
        buttons |= Buttons.reload
      }
      if (gamepad.buttons[1]?.pressed) {
        buttons |= Buttons.crouch
      }
      if (gamepad.buttons[3]?.pressed) {
        buttons |= Buttons.roll
      }
      if (gamepad.buttons[4]?.pressed) {
        buttons |= Buttons.throw
      }
      if (gamepad.buttons[5]?.pressed) {
        buttons |= Buttons.interact
      }
      if (gamepad.buttons[12]?.pressed) {
        buttons |= Buttons.callout
      }
      if (gamepad.buttons[10]?.pressed) {
        buttons |= Buttons.sprint
      }
    }
    const length = Math.max(1, Math.hypot(x, z))
    x /= length
    z /= length
    const yaw = this.settings.view === 'top' ? 0 : this.yaw
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    return {
      seq,
      moveX: x * cos + z * sin,
      moveZ: z * cos - x * sin,
      yaw: this.yaw,
      pitch: this.pitch,
      buttons,
    }
  }
  destroy(): void {
    this.release()
    this.abort.abort()
    this.mouse.off('mousemove', this.look)
    this.mouse.off('mousedown', this.mouseDown)
    this.keyboard.off('keydown', this.keyDown)
    this.mouse.detach()
    this.keyboard.detach()
    this.controls.remove()
  }
}
