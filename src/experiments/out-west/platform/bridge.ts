/**
 * The native bridge (spec §11.2). On the web every call is a no-op or a browser fallback. Inside
 * the future Expo WebView it talks to `globalThis.ReactNativeWebView`:
 *
 * - The app is detected by `globalThis.ReactNativeWebView` plus the UA token `OutWestApp/<n>`
 *   (`applicationNameForUserAgent: "OutWestApp/1"`).
 * - Requests are `{ v: 1, id, type, payload }` strings sent with `postMessage`. Replies and native
 *   events arrive as a `CustomEvent('ow-bridge', { detail: { v, id?, type, ok?, payload } })`
 *   dispatched on `window` by injected JavaScript.
 *
 * Game code imports `platform` and never checks the shell itself. Owned by stream A.
 */
import { isRecord } from '../contract/validate.ts'
import type { HapticKind, Insets, SharePayload, SignInPurpose } from './bridge-types.ts'
import { onPause, onResume } from './lifecycle.ts'
import { APP_UA, IOS_UA, nativeChannel, onNative, post, request, userAgent } from './native.ts'

export type { HapticKind, Insets, SharePayload, SignInPurpose } from './bridge-types.ts'

const MAC_PLATFORM = /\bMac/u

export type PlatformKind = 'web' | 'ios-app' | 'android-app'

/** Where access tokens come from: the cookie refresh on the web, the native secure store in the app. */
export interface TokenSource {
  getAccessToken: () => Promise<string | null>
}

export interface Platform {
  readonly kind: PlatformKind
  /** Own shot, being hit, optional heartbeat. Never the call or a fake-out (see haptics.ts). */
  haptic: (kind: HapticKind) => void
  share: (p: SharePayload) => Promise<void>
  /** Current safe-area insets in CSS px (also mirrored into `--sai-*` by viewport.ts). */
  safeArea: () => Insets
  readonly tokens: TokenSource
  /** In the app: opens the system auth session (§11.3). On the web: resolves; use net/auth. */
  signIn: (purpose: SignInPurpose) => Promise<void>
  onPause: (cb: () => void) => () => void
  onResume: (cb: () => void) => () => void
}

/** True inside the Expo WebView shell. */
export const isNativeShell = (): boolean => nativeChannel() !== null && APP_UA.test(userAgent())

/** Detects the shell from the UA token plus the injected channel. */
export function detectKind(ua = userAgent(), native = nativeChannel() !== null): PlatformKind {
  if (!(native && APP_UA.test(ua))) {
    return 'web'
  }
  return IOS_UA.test(ua) ? 'ios-app' : 'android-app'
}

/** True on iPhone/iPad browsers (including iPadOS reporting as a Mac with touch). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return (
    IOS_UA.test(navigator.userAgent) ||
    (MAC_PLATFORM.test(navigator.platform) && navigator.maxTouchPoints > 1)
  )
}

const ZERO: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
let nativeInsets: Insets | null = null

function readCssInsets(): Insets {
  if (typeof document === 'undefined') {
    return ZERO
  }
  const style = getComputedStyle(document.documentElement)
  const px = (name: string): number => Number.parseFloat(style.getPropertyValue(name)) || 0
  return {
    top: px('--sai-top'),
    right: px('--sai-right'),
    bottom: px('--sai-bottom'),
    left: px('--sai-left'),
  }
}

/** Native safe-area override, pushed by the app; viewport.ts mirrors it into `--sai-*`. */
export const nativeSafeArea = (): Insets | null => nativeInsets

onNative('safeArea', (payload) => {
  if (
    isRecord(payload) &&
    ['top', 'right', 'bottom', 'left'].every((k) => typeof payload[k] === 'number')
  ) {
    nativeInsets = payload
    globalThis.dispatchEvent(new CustomEvent('ow-safe-area'))
  }
})

async function webShare(p: SharePayload): Promise<void> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: p.title, url: p.url })
      return
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
    }
  }
  await navigator.clipboard?.writeText(p.url)
}

let webTokenSource: TokenSource | null = null

/** net/auth registers the cookie-refresh token source here (keeps the bridge free of a cycle). */
export function provideWebTokens(source: TokenSource): void {
  webTokenSource = source
}

const webTokens: TokenSource = {
  getAccessToken: () => webTokenSource?.getAccessToken() ?? Promise.resolve(null),
}

const nativeTokens: TokenSource = {
  async getAccessToken() {
    try {
      const token = await request('tokens.access')
      return typeof token === 'string' ? token : null
    } catch {
      return null
    }
  },
}

function createPlatform(): Platform {
  const kind = detectKind()
  const app = kind !== 'web'
  return {
    kind,
    haptic: (h) => {
      if (app) {
        post('haptic', { kind: h })
      }
    },
    share: (p) => (app ? request('share', p).then(() => undefined) : webShare(p)),
    safeArea: () => nativeInsets ?? readCssInsets(),
    tokens: app ? nativeTokens : webTokens,
    signIn: (purpose) =>
      app ? request('signIn', { purpose }).then(() => undefined) : Promise.resolve(),
    onPause,
    onResume,
  }
}

/** The platform this page runs on. */
export const platform: Platform = createPlatform()
