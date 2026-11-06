/**
 * The raw native channel to the future Expo WebView: `globalThis.ReactNativeWebView.postMessage` out,
 * `CustomEvent('ow-bridge')` in. Messages are `{ v: 1, id, type, payload }`. Everything here is a
 * no-op (or rejects) on the web. Most code should use `bridge.ts` instead. Owned by stream A.
 */
import { isRecord } from '../contract/validate.ts'
import type { BridgeCommands, BridgeEvents } from './bridge-types.ts'

const BRIDGE_VERSION = 1
export const APP_UA = /\bOutWestApp\/\d+/u
export const IOS_UA = /\b(?:iPhone|iPad|iPod)\b|\bOS \d+_\d+ like Mac OS X/u
const REQUEST_TIMEOUT_MS = 10_000

interface NativeChannel {
  postMessage: (message: string) => void
}

interface BridgeDetail {
  v: number
  id?: string
  type: string
  ok?: boolean
  payload?: unknown
}

const isNativeChannel = (v: unknown): v is NativeChannel =>
  isRecord(v) && typeof v.postMessage === 'function'

function isBridgeDetail(v: unknown): v is BridgeDetail {
  return isRecord(v) && v.v === BRIDGE_VERSION && typeof v.type === 'string'
}

export function nativeChannel(): NativeChannel | null {
  const rn: unknown = Reflect.get(globalThis, 'ReactNativeWebView')
  return isNativeChannel(rn) ? rn : null
}

export const userAgent = (): string => (typeof navigator === 'undefined' ? '' : navigator.userAgent)

let seq = 0
const pending = new Map<string, (detail: BridgeDetail) => void>()
const eventHandlers = new Map<string, Set<(payload: unknown) => void>>()

function onBridgeEvent(e: Event): void {
  const detail: unknown = (e as CustomEvent<unknown>).detail
  if (!isBridgeDetail(detail)) {
    return
  }
  const d = detail
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)?.(d)
    pending.delete(d.id)
    return
  }
  for (const cb of eventHandlers.get(d.type) ?? []) {
    cb(d.payload)
  }
}

if (typeof document !== 'undefined') {
  globalThis.addEventListener('ow-bridge', onBridgeEvent)
}

/** Fire-and-forget message to the native side. No-op on the web. */
export function post<K extends keyof BridgeCommands>(type: K, payload?: BridgeCommands[K]): void {
  nativeChannel()?.postMessage(
    JSON.stringify({ v: BRIDGE_VERSION, id: `m${++seq}`, type, payload }),
  )
}

/** Request/response to the native side. Rejects on the web, on timeout, or when native says no. */
export function request<K extends keyof BridgeCommands>(
  type: K,
  payload?: BridgeCommands[K],
): Promise<unknown> {
  const channel = nativeChannel()
  if (!channel) {
    return Promise.reject(new Error('no native bridge'))
  }
  const id = `r${++seq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`bridge ${type} timed out`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, (d) => {
      clearTimeout(timer)
      if (d.ok === false) {
        reject(new Error(typeof d.payload === 'string' ? d.payload : `bridge ${type} failed`))
      } else {
        resolve(d.payload)
      }
    })
    channel.postMessage(JSON.stringify({ v: BRIDGE_VERSION, id, type, payload }))
  })
}

/** Subscribes to a native event (e.g. `pause`, `resume`, `safeArea`). Returns an unsubscribe. */
export function onNative<K extends keyof BridgeEvents>(
  type: K,
  cb: (payload: BridgeEvents[K]) => void,
): () => void {
  let set = eventHandlers.get(type)
  if (!set) {
    set = new Set()
    eventHandlers.set(type, set)
  }
  const handler = (payload: unknown): void => cb(payload as BridgeEvents[K])
  set.add(handler)
  return () => set.delete(handler)
}
