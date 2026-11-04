/**
 * Device, posture and live-resize handling for the three Apple targets (and everything between):
 *
 * - **iPhone 13 mini** (375×812 pt, DPR 3): the small-screen baseline.
 * - **iPhone Duo** (Apple's foldable, Oct 2026): outer 5.4" 466×678 pt and inner 7.6" 669×951 pt
 *   (951×669 held open), both DPR 3 and both near 1.42:1. Folding moves the page to the other
 *   panel mid-session: the viewport changes size AND shape while a duel runs.
 * - **iPad**: every size class, Split View and Stage Manager windows, a keyboard, a trackpad and
 *   game controllers.
 *
 * What it does, once `installDevice()` runs at boot:
 *
 * 1. Classifies the device (`form`: phone, fold-outer, fold-inner, tablet, desktop), the window
 *    (`full` or a `split` window smaller than its screen) and the input (`touch`, `pointer`, or
 *    `hybrid`: an iPad with a trackpad), and mirrors them onto `<html>` as `data-ow-form`,
 *    `data-ow-window`, `data-ow-input` and `data-ow-scale` (`s`, `m`, `l`, `xl`) for the CSS layer
 *    in `ui/device.css`. They're refreshed on every viewport change.
 * 2. Detects a **posture change** (fold or unfold: the screen itself changes, not just its
 *    rotation) and tells `onPostureChange` subscribers, so a single-player duel can pause
 *    instead of carrying on while the player swaps panels.
 * 3. Re-dispatches `resize` when WebKit reports the new size late. On iOS the first `resize`
 *    after a rotation or a fold can carry the old `innerWidth`/`innerHeight` (and
 *    `orientationchange` fires before either changes), which left the canvas at the old aspect
 *    until something else resized it. A trailing check at the next frame and at 150, 400 and
 *    1000 ms fires one more `resize` if the size moved since the last one, so every existing
 *    `resize` listener (the renderer, the Frontier camera, cached HUD sizes) catches up.
 * 4. Blocks Safari's pinch zoom gesture (`gesturestart`), which ignores `maximum-scale` and
 *    `touch-action` on iOS and can zoom the whole game mid-walk.
 *
 * There is no Device Posture or Viewport Segments API in Safari (checked on the iOS 27.1 iPhone
 * Duo simulator), so the fold is inferred from the screen: rotation swaps `screen.width` and
 * `screen.height`, a fold changes the pair.
 */
import { IOS_UA } from './native.ts'

export type FormFactor = 'phone' | 'fold-outer' | 'fold-inner' | 'tablet' | 'desktop'
export type WindowMode = 'full' | 'split'
export type InputKind = 'touch' | 'pointer' | 'hybrid'
/** UI scale step: `s` narrow windows, `m` phones, `l` small tablets and the open foldable, `xl` big tablets. */
export type UiScale = 's' | 'm' | 'l' | 'xl'

export interface DeviceInfo {
  form: FormFactor
  window: WindowMode
  input: InputKind
  scale: UiScale
  /** Viewport in CSS px. */
  w: number
  h: number
  /** The physical screen, short and long side, in CSS px (posture key). */
  screenShort: number
  screenLong: number
  dpr: number
  landscape: boolean
}

const IPHONE_UA = /\biPhone\b/u
const IPAD_UA = /\biPad\b/u
const ANDROID_UA = /\bAndroid\b/u
const MOBILE_UA = /\bMobile\b/u
const MAC_UA = /\bMacintosh\b/u

/** Phones are taller than 1.75:1; a foldable's panels are squarer (Duo: 1.46 outer, 1.42 inner). */
const FOLD_ASPECT = 1.62
/** The short side past which a phone-class device must be an unfolded panel. */
const FOLD_INNER_SHORT = 600
/** A window this much smaller than its screen is a Split View or Stage Manager window. */
const SPLIT_FRACTION = 0.92
const TRAILING_MS = [150, 400, 1000] as const

const mq = (q: string): boolean => typeof matchMedia === 'function' && matchMedia(q).matches

function screenSides(): [number, number] {
  const sw = globalThis.screen?.width || globalThis.innerWidth || 1
  const sh = globalThis.screen?.height || globalThis.innerHeight || 1
  return [Math.min(sw, sh), Math.max(sw, sh)]
}

function formFactor(ua: string, short: number, long: number): FormFactor {
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1
  const phone = IPHONE_UA.test(ua) || (ANDROID_UA.test(ua) && MOBILE_UA.test(ua))
  if (phone) {
    if (short >= FOLD_INNER_SHORT) {
      return 'fold-inner'
    }
    return long / short < FOLD_ASPECT ? 'fold-outer' : 'phone'
  }
  // iPadOS Safari asks for desktop sites: a Mac UA with a touch screen is an iPad
  if (IPAD_UA.test(ua) || (MAC_UA.test(ua) && touch) || (ANDROID_UA.test(ua) && touch)) {
    return 'tablet'
  }
  if (IOS_UA.test(ua)) {
    return 'phone'
  }
  return touch && mq('(pointer: coarse)') ? 'tablet' : 'desktop'
}

function inputKind(): InputKind {
  const coarse = mq('(pointer: coarse)') || mq('(any-pointer: coarse)')
  const fine = mq('(any-pointer: fine)') && mq('(any-hover: hover)')
  if (coarse && fine) {
    return 'hybrid'
  }
  return coarse ? 'touch' : 'pointer'
}

function uiScale(form: FormFactor, w: number, h: number): UiScale {
  const short = Math.min(w, h)
  if (w < 360) {
    return 's'
  }
  if (form === 'tablet' || form === 'fold-inner') {
    if (short >= 960) {
      return 'xl'
    }
    if (short >= 640) {
      return 'l'
    }
  }
  return 'm'
}

/** Reads the device right now (cheap: a few media queries). */
export function readDevice(): DeviceInfo {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const w = globalThis.innerWidth || 1
  const h = globalThis.innerHeight || 1
  const [screenShort, screenLong] = screenSides()
  const form = formFactor(ua, screenShort, screenLong)
  const splitW = w < (w > h ? screenLong : screenShort) * SPLIT_FRACTION
  const split = (form === 'tablet' || form === 'desktop') && splitW
  return {
    form,
    window: split ? 'split' : 'full',
    input: inputKind(),
    scale: uiScale(form, w, h),
    w,
    h,
    screenShort,
    screenLong,
    dpr: globalThis.devicePixelRatio || 1,
    landscape: w > h,
  }
}

let current: DeviceInfo | null = null
const postureListeners = new Set<(next: DeviceInfo, prev: DeviceInfo) => void>()
const changeListeners = new Set<(info: DeviceInfo) => void>()

/** The device as of the last viewport change (reads it on first use). */
export function device(): DeviceInfo {
  current ??= readDevice()
  return current
}

/**
 * Called when the device folds or unfolds (the screen itself changed: not a rotation, not a
 * Split View or Stage Manager resize). Returns an unsubscribe.
 */
export function onPostureChange(cb: (next: DeviceInfo, prev: DeviceInfo) => void): () => void {
  postureListeners.add(cb)
  return () => postureListeners.delete(cb)
}

/** Called after every settled viewport change, with the fresh reading. Returns an unsubscribe. */
export function onDeviceChange(cb: (info: DeviceInfo) => void): () => void {
  changeListeners.add(cb)
  return () => changeListeners.delete(cb)
}

function mirror(info: DeviceInfo, root: HTMLElement): void {
  const d = root.dataset
  d.owForm = info.form
  d.owWindow = info.window
  d.owInput = info.input
  d.owScale = info.scale
}

function isPostureChange(next: DeviceInfo, prev: DeviceInfo): boolean {
  // a fold swaps panels: the screen's pair of sides changes (rotation only swaps them)
  const moved = (a: number, b: number): boolean => Math.abs(a - b) > Math.max(24, b * 0.08)
  return moved(next.screenShort, prev.screenShort) || moved(next.screenLong, prev.screenLong)
}

let installed: (() => void) | null = null

/**
 * Installs the classification, the posture watcher, the late-resize catch-up and the pinch
 * guard. Idempotent; returns a dispose function.
 */
export function installDevice(root: HTMLElement = document.documentElement): () => void {
  if (installed) {
    return installed
  }
  current = readDevice()
  mirror(current, root)
  // the size every `resize` listener last saw (ours or the browser's)
  let seenW = globalThis.innerWidth
  let seenH = globalThis.innerHeight
  let frame = 0
  const timers: ReturnType<typeof setTimeout>[] = []

  const settle = (): void => {
    const prev = device()
    const next = readDevice()
    current = next
    mirror(next, root)
    if (isPostureChange(next, prev)) {
      for (const cb of postureListeners) {
        cb(next, prev)
      }
    }
    for (const cb of changeListeners) {
      cb(next)
    }
  }

  /** Fires one more `resize` when the size moved after the last one the page saw. */
  const catchUp = (): void => {
    const w = globalThis.innerWidth
    const h = globalThis.innerHeight
    if (w !== seenW || h !== seenH) {
      globalThis.dispatchEvent(new Event('resize'))
      return
    }
    if (device().w !== w || device().h !== h || isPostureChange(readDevice(), device())) {
      settle()
    }
  }

  const schedule = (): void => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(catchUp)
    for (const t of timers.splice(0)) {
      clearTimeout(t)
    }
    for (const ms of TRAILING_MS) {
      timers.push(setTimeout(catchUp, ms))
    }
  }

  const onResize = (): void => {
    seenW = globalThis.innerWidth
    seenH = globalThis.innerHeight
    settle()
    schedule()
  }

  const blockPinch = (e: Event): void => e.preventDefault()
  const vv = globalThis.visualViewport ?? undefined
  globalThis.addEventListener('resize', onResize)
  globalThis.addEventListener('orientationchange', schedule)
  vv?.addEventListener('resize', schedule)
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
  ro?.observe(root)
  for (const ev of ['gesturestart', 'gesturechange']) {
    document.addEventListener(ev, blockPinch, { passive: false })
  }

  installed = () => {
    cancelAnimationFrame(frame)
    for (const t of timers.splice(0)) {
      clearTimeout(t)
    }
    globalThis.removeEventListener('resize', onResize)
    globalThis.removeEventListener('orientationchange', schedule)
    vv?.removeEventListener('resize', schedule)
    ro?.disconnect()
    for (const ev of ['gesturestart', 'gesturechange']) {
      document.removeEventListener(ev, blockPinch)
    }
    installed = null
  }
  return installed
}
