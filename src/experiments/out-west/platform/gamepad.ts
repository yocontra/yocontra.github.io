// biome-ignore-all lint/security/noSecrets: CSS selector lists, not credentials
// biome-ignore-all lint/suspicious/noUnnecessaryConditions: pad state is mutated across polls; Biome narrows the module flags to their initialisers
/**
 * Game controllers (and arrow keys) for Quick Draw, Bounty Hunt and every menu: an iPad with a
 * PlayStation or Xbox pad, or a Backbone on an iPhone, plays the whole game without touching
 * the screen. The Frontier has its own pad support (`ffa/client/controls.ts`); this module is
 * installed by the Quick Draw page only.
 *
 * Standard mapping, in play (no menu open):
 * - **A / Cross** fires and, held, walks: the same one-button game as a held finger.
 * - **RT / R2** or **X / Square** fires. **Left stick up**, **D-pad up** or **LT / L2** walks.
 * - **Start / Options** or **View / Share** pauses. **Y / Triangle** retries, **B / Circle** skips.
 *
 * In a menu (a sheet, the saloon, the pause menu, the Outfitter, a receipt): the D-pad or the left
 * stick moves focus to the nearest control in that direction, **A** presses it, **B** or **Start**
 * backs out (an Escape). The arrow keys move focus the same way for an iPad's keyboard. On the
 * title, **A** or **Start** is the press that starts the game.
 *
 * Fire presses carry the pad's own `timestamp` (the `performance.now()` timebase, when the
 * browser last saw the pad change), not the frame that polled it, so a pad is judged on when the
 * button went down, like a key or a tap. Safari doesn't count a pad press as a user gesture:
 * audio unlocks on the first touch or key instead.
 */

export type PadAction = 'fire' | 'pause' | 'retry' | 'skip'

export interface PadPress {
  action: PadAction
  /** performance.now() timebase. */
  t: number
}

const BTN = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lt: 6,
  rt: 7,
  back: 8,
  start: 9,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const
const STICK = 0.55
const TRIGGER = 0.4
const REPEAT_FIRST_MS = 380
const REPEAT_MS = 140

/** Anything the player can be inside of; the newest visible, non-inert one owns the pad. */
const MENU = [
  '.ow-sheet.on',
  '.ow-store.on',
  '.ow-board.on',
  '.ow-menu.on',
  '.ow-end.on',
  '.ow-results.on',
  '.ow-hub.on',
  '[role="dialog"]',
  '[role="alertdialog"]',
].join(', ')
const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="tab"], [role="radio"]'
/** Keys whose arrows belong to the control (text, sliders, radio groups, tab lists). */
const OWNS_ARROWS =
  'input, textarea, select, [contenteditable], [role="slider"], [role="radiogroup"]'

type Dir = 'up' | 'down' | 'left' | 'right'

const listeners = new Set<(p: PadPress) => void>()
let walkHeld = false

/** Subscribe to pad presses meant for the game (never fired while a menu owns the pad). */
export function onPad(cb: (p: PadPress) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** True while a pad asks to walk (A held, stick or D-pad up, LT). */
export const padWalking = (): boolean => walkHeld

function visible(el: Element): boolean {
  if (!(el instanceof HTMLElement) || el.closest('[inert]')) {
    return false
  }
  const r = el.getBoundingClientRect()
  return (
    r.width > 0 &&
    r.height > 0 &&
    el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  )
}

/** The menu that owns input now, or null in play. */
export function activeMenu(): HTMLElement | null {
  const open = [...document.querySelectorAll<HTMLElement>(MENU)].filter(visible)
  // the saloon sits under its sheets: prefer anything else that's open
  const top = open.filter((m) => !m.classList.contains('ow-hub')).at(-1) ?? open.at(-1)
  return top && focusables(top).length > 0 ? top : null
}

function focusables(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible)
}

function center(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

function focusEl(el: HTMLElement): void {
  document.documentElement.classList.add('ow-pad')
  el.focus({ preventScroll: true })
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function firstChoice(items: HTMLElement[]): HTMLElement | undefined {
  return items.find((e) => e.classList.contains('ow-btn-primary')) ?? items[0]
}

/** Moves focus to the nearest control in `dir` inside the open menu. Returns true when it moved. */
export function moveFocus(menu: HTMLElement, dir: Dir): boolean {
  const items = focusables(menu)
  const cur = document.activeElement
  if (!(cur instanceof HTMLElement && items.includes(cur))) {
    const first = firstChoice(items)
    if (first) {
      focusEl(first)
    }
    return first !== undefined
  }
  const from = center(cur)
  let best: HTMLElement | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const el of items) {
    if (el === cur) {
      continue
    }
    const c = center(el)
    const dx = c.x - from.x
    const dy = c.y - from.y
    const along = { up: -dy, down: dy, left: -dx, right: dx }[dir]
    const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy)
    // only what lies that way (a 2:1 cone): right from the last tile in a row stays put
    if (along <= 4 || across > along * 2) {
      continue
    }
    const score = along + across * 2.2
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  if (best) {
    focusEl(best)
  }
  return best !== null
}

function press(menu: HTMLElement): void {
  const cur = document.activeElement
  if (cur instanceof HTMLElement && menu.contains(cur) && cur.matches(FOCUSABLE)) {
    cur.click()
    return
  }
  const first = firstChoice(focusables(menu))
  if (first) {
    focusEl(first)
  }
}

function key(code: string, keyName = code): void {
  const init = { code, key: keyName, bubbles: true, cancelable: true }
  globalThis.dispatchEvent(new KeyboardEvent('keydown', init))
  globalThis.dispatchEvent(new KeyboardEvent('keyup', init))
}

function titleUp(): boolean {
  const t = document.querySelector('.ow-title')
  return t !== null && !t.classList.contains('wipe') && !t.classList.contains('pressed')
}

interface PadState {
  buttons: boolean[]
  dir: Dir | null
  dirRepeat: number
}

function readDir(gp: Gamepad): Dir | null {
  const b = (i: number): boolean => gp.buttons[i]?.pressed === true
  const ax = gp.axes[0] ?? 0
  const ay = gp.axes[1] ?? 0
  if (b(BTN.up) || ay < -STICK) {
    return 'up'
  }
  if (b(BTN.down) || ay > STICK) {
    return 'down'
  }
  if (b(BTN.left) || ax < -STICK) {
    return 'left'
  }
  if (b(BTN.right) || ax > STICK) {
    return 'right'
  }
  return null
}

function pressedAt(gp: Gamepad): boolean[] {
  return gp.buttons.map((btn, i) =>
    i === BTN.lt || i === BTN.rt ? btn.value > TRIGGER || btn.pressed : btn.pressed,
  )
}

function emit(action: PadAction, gp: Gamepad): void {
  const now = performance.now()
  // the pad's own change time, when the browser offers a sane one
  const t = gp.timestamp > 0 && gp.timestamp <= now && now - gp.timestamp < 100 ? gp.timestamp : now
  for (const cb of listeners) {
    cb({ action, t })
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pad's edges, routed to the menu, the title or the game
function pollPad(gp: Gamepad, s: PadState, now: number): void {
  const held = pressedAt(gp)
  const down = (i: number): boolean => held[i] === true && s.buttons[i] !== true
  const dir = readDir(gp)
  const changed =
    held.some((h, i) => h !== (s.buttons[i] === true)) ||
    dir !== s.dir ||
    (dir !== null && now >= s.dirRepeat)
  if (!changed) {
    // nothing moved: skip the DOM reads (a layout per frame mid-duel is a hitch)
    return
  }
  const menu = activeMenu()
  if (menu) {
    walkHeld = false
    if (dir && (dir !== s.dir || now >= s.dirRepeat)) {
      moveFocus(menu, dir)
      s.dirRepeat = now + (dir === s.dir ? REPEAT_MS : REPEAT_FIRST_MS)
    }
    if (down(BTN.a)) {
      press(menu)
    }
    if (down(BTN.b) || down(BTN.start)) {
      key('Escape')
    }
  } else if (titleUp()) {
    if (down(BTN.a) || down(BTN.start)) {
      key('Enter')
    }
  } else {
    walkHeld = held[BTN.a] === true || held[BTN.lt] === true || dir === 'up'
    // a held stick walks; it isn't a repeating menu move, so it never re-reads the DOM per frame
    s.dirRepeat = Number.POSITIVE_INFINITY
    if (down(BTN.a) || down(BTN.rt) || down(BTN.x)) {
      emit('fire', gp)
    }
    if (down(BTN.start) || down(BTN.back)) {
      emit('pause', gp)
    }
    if (down(BTN.y)) {
      emit('retry', gp)
    }
    if (down(BTN.b)) {
      emit('skip', gp)
    }
  }
  s.dir = dir
  s.buttons = held
}

/** Arrow keys walk the focus through an open menu (an iPad keyboard, a desktop). */
function onArrow(e: KeyboardEvent): void {
  const dir = (
    { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const
  )[e.code as 'ArrowUp']
  if (!dir || e.altKey || e.metaKey || e.ctrlKey) {
    return
  }
  const t = e.target
  if (t instanceof HTMLElement && t.closest(OWNS_ARROWS)) {
    return
  }
  const menu = activeMenu()
  if (menu && moveFocus(menu, dir)) {
    e.preventDefault()
    e.stopImmediatePropagation()
  }
}

let installed: (() => void) | null = null

/** Starts listening for pads (and menu arrow keys). Idempotent; returns a dispose function. */
export function installGamepad(): () => void {
  if (installed) {
    return installed
  }
  const states = new Map<number, PadState>()
  let frame = 0
  const loop = (now: number): void => {
    const pads = navigator.getGamepads()
    let any = false
    for (const gp of pads) {
      if (!gp?.connected) {
        continue
      }
      any = true
      let s = states.get(gp.index)
      if (!s) {
        // a pad's first sight: whatever is already held doesn't count as a press
        s = { buttons: pressedAt(gp), dir: readDir(gp), dirRepeat: now }
        states.set(gp.index, s)
        continue
      }
      pollPad(gp, s, now)
    }
    if (!any) {
      walkHeld = false
    }
    frame = any ? requestAnimationFrame(loop) : 0
  }
  const start = (): void => {
    if (frame === 0) {
      frame = requestAnimationFrame(loop)
    }
  }
  const lost = (e: GamepadEvent): void => {
    states.delete(e.gamepad.index)
  }
  // pointer or touch use hides the pad focus ring again
  const pointer = (): void => document.documentElement.classList.remove('ow-pad')
  const supported = typeof navigator.getGamepads === 'function'
  if (supported) {
    globalThis.addEventListener('gamepadconnected', start)
    globalThis.addEventListener('gamepaddisconnected', lost)
    if (navigator.getGamepads().some((g) => g?.connected)) {
      start()
    }
  }
  globalThis.addEventListener('keydown', onArrow, true)
  globalThis.addEventListener('pointerdown', pointer, true)
  installed = () => {
    cancelAnimationFrame(frame)
    frame = 0
    globalThis.removeEventListener('gamepadconnected', start)
    globalThis.removeEventListener('gamepaddisconnected', lost)
    globalThis.removeEventListener('keydown', onArrow, true)
    globalThis.removeEventListener('pointerdown', pointer, true)
    installed = null
  }
  return installed
}
