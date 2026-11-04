// biome-ignore-all lint/suspicious/noUnnecessaryConditions: class fields are flags mutated from outside the method; Biome narrows them to their literal initializer
/**
 * Unified keyboard / mouse / touch input. Every press carries the browser's
 * event.timeStamp (performance.now() timebase) so the duel can be judged on
 * when the player actually pressed, not when a frame got around to it.
 */

export type Action = 'walk' | 'fire' | 'pause' | 'retry' | 'skip'

export interface Press {
  action: Action
  /** event.timeStamp, ms, performance.now() timebase. */
  t: number
  source: 'key' | 'pointer'
  x: number
  y: number
  /** True when a pointer press began while the pointer was already held for walking. */
}

export type KeyMap = Record<Action, string[]>

export const DEFAULT_KEYS: KeyMap = {
  walk: ['KeyW', 'ArrowUp', 'ArrowLeft'],
  fire: ['Space', 'KeyJ', 'Enter'],
  pause: ['Escape', 'KeyP'],
  retry: ['KeyR'],
  skip: ['Tab'],
}

export class Input {
  keys: KeyMap
  toggleWalk = false
  private readonly heldKeys = new Set<string>()
  private readonly pointers = new Set<number>()
  private toggled = false
  private readonly listeners = new Set<(p: Press) => void>()
  private readonly target: HTMLElement
  /** When false, pointer presses are ignored (menus are open). */
  enabled = true
  /** Called with every keydown so a remap UI can capture it. */
  capture: ((code: string) => void) | null = null

  constructor(target: HTMLElement, keys: KeyMap) {
    this.target = target
    this.keys = keys
    globalThis.addEventListener('keydown', this.onKeyDown)
    globalThis.addEventListener('keyup', this.onKeyUp)
    target.addEventListener('pointerdown', this.onPointerDown)
    globalThis.addEventListener('pointerup', this.onPointerUp)
    globalThis.addEventListener('pointercancel', this.onPointerUp)
    globalThis.addEventListener('blur', this.onBlur)
    target.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  on(cb: (p: Press) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(p: Press): void {
    for (const l of this.listeners) {
      l(p)
    }
  }

  actionFor(code: string): Action | null {
    for (const a of Object.keys(this.keys) as Action[]) {
      if (this.keys[a].includes(code)) {
        return a
      }
    }
    return null
  }

  /** Is the player asking to walk right now? */
  get walking(): boolean {
    if (this.toggleWalk) {
      return this.toggled
    }
    if (this.pointers.size > 0) {
      return true
    }
    for (const code of this.keys.walk) {
      if (this.heldKeys.has(code)) {
        return true
      }
    }
    return false
  }

  get pointerHeld(): boolean {
    return this.pointers.size > 0
  }

  resetToggle(): void {
    this.toggled = false
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.capture) {
      e.preventDefault()
      this.capture(e.code)
      return
    }
    const a = this.actionFor(e.code)
    if (!a || (a !== 'pause' && onMenuControl(e))) {
      return
    }
    // Let Tab work for focus when a menu is open.
    if (!this.enabled && a !== 'pause') {
      return
    }
    e.preventDefault()
    if (e.repeat) {
      return
    }
    this.heldKeys.add(e.code)
    if (a === 'walk' && this.toggleWalk) {
      this.toggled = !this.toggled
    }
    this.emit({ action: a, t: e.timeStamp, source: 'key', x: -1, y: -1 })
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.heldKeys.delete(e.code)
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled) {
      return
    }
    if (e.button !== 0 && e.pointerType === 'mouse') {
      return
    }
    e.preventDefault()
    this.pointers.add(e.pointerId)
    try {
      this.target.setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    if (this.toggleWalk) {
      this.toggled = !this.toggled
    }
    this.emit({ action: 'fire', t: e.timeStamp, source: 'pointer', x: e.clientX, y: e.clientY })
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId)
  }

  private readonly onBlur = (): void => {
    this.heldKeys.clear()
    this.pointers.clear()
  }
}

const CONTROL =
  'button, a[href], input, select, textarea, [contenteditable], [role="radio"], [role="tab"]'
const MENU = '[role="dialog"], [role="alertdialog"], .ow-hub, .ow-sheet'

/**
 * Is this key press aimed at a visible menu control (a focused Buy button, a text field)? Then
 * Space and Enter belong to the browser (activate the button, type the space), never the duel:
 * swallowing them left a keyboard player unable to confirm a purchase.
 */
function onMenuControl(e: KeyboardEvent): boolean {
  const t = e.target
  if (!(t instanceof HTMLElement) || t === document.body || !t.closest(CONTROL)) {
    return false
  }
  return (
    t.closest(MENU) !== null &&
    t.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  )
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) {
    return code.slice(3)
  }
  if (code.startsWith('Digit')) {
    return code.slice(5)
  }
  const map: Record<string, string> = {
    Space: 'Space',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Escape: 'Esc',
    Enter: 'Enter',
    Tab: 'Tab',
  }
  return map[code] ?? code
}
