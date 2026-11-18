/** Native display ownership is separate from the raw orientation getter (which can be UNKNOWN). */
import { nativeSafari } from './simulator-native.ts'
import {
  openSafariWhenReady,
  readSafariReadiness,
  type SafariReadinessEvent,
  until,
} from './simulator-process.ts'

type Name = 'PORTRAIT' | 'PORTRAIT_UPSIDE_DOWN' | 'LANDSCAPE_LEFT' | 'LANDSCAPE_RIGHT'
type Target = 'PORTRAIT' | 'LANDSCAPE_LEFT'
export interface OrientationClient {
  call: (op: string, args?: Record<string, unknown>, timeout?: number) => Promise<unknown>
}
export interface NativeDisplay {
  coordinate_space: 'screen'
  width: number
  height: number
  display: { rotation: number; scale: number; unique_id: string }
}
export interface InitialDisplay {
  rawOrientation: unknown
  screen: NativeDisplay
  signature: string
  safariPID: number
  restoreName: Name
  restoreBasis: 'native getter' | 'measured dedicated-device AX mapping'
  commandAttempted: boolean
}
type Observe = (value: Record<string, unknown>) => Promise<void> | void
const names = new Set<Name>([
  'PORTRAIT',
  'PORTRAIT_UPSIDE_DOWN',
  'LANDSCAPE_LEFT',
  'LANDSCAPE_RIGHT',
])
const displayChanged = 'Simulator display changed during the operation'
const deviceId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
export function nativeDisplay(ax: unknown): NativeDisplay {
  const value = (ax as { screen?: NativeDisplay } | null)?.screen
  if (
    !(
      value?.coordinate_space === 'screen' &&
      value.display &&
      [value.width, value.height, value.display.rotation, value.display.scale].every(
        Number.isFinite,
      ) &&
      value.width > 0 &&
      value.height > 0 &&
      value.display.scale > 0 &&
      typeof value.display.unique_id === 'string' &&
      value.display.unique_id.length > 0
    )
  ) {
    throw new Error('Actual native AX display geometry unavailable')
  }
  return structuredClone(value)
}
export function displaySignature(screen: NativeDisplay): string {
  return JSON.stringify([
    screen.coordinate_space,
    screen.width,
    screen.height,
    screen.display.rotation,
    screen.display.scale,
    screen.display.unique_id,
  ])
}
export function initialDisplay(
  udid: string,
  state: { ax: unknown; apps: unknown },
  raw: unknown,
): InitialDisplay {
  const identity = nativeSafari(state.ax, state.apps)
  if (!identity) {
    throw new Error('Native Safari identity unavailable for initial display')
  }
  const screen = nativeDisplay(state.ax)
  let restoreName: Name
  let restoreBasis: InitialDisplay['restoreBasis'] = 'native getter'
  if (typeof raw === 'string' && names.has(raw as Name)) {
    restoreName = raw as Name
  } else if (raw === 'UNKNOWN' && deviceId.test(udid)) {
    // The runner has already selected an owned iPhone 13 mini. Use only calibrated AX displays.
    const { width, height, display } = screen
    if (display.scale === 3 && display.rotation === 0 && width === 375 && height === 812) {
      restoreName = 'PORTRAIT'
    } else if (display.scale === 3 && display.rotation === 270 && width === 812 && height === 375) {
      restoreName = 'LANDSCAPE_LEFT'
    } else {
      throw new Error('No measured restoration mapping for initial UNKNOWN display')
    }
    restoreBasis = 'measured dedicated-device AX mapping'
  } else {
    throw new Error('Restorable initial native display unavailable')
  }
  return {
    rawOrientation: raw,
    screen,
    signature: displaySignature(screen),
    safariPID: identity.pid,
    restoreName,
    restoreBasis,
    commandAttempted: false,
  }
}
/** Only a commanded settle can re-read the exact display-snapshot consistency error. */
export async function readOrientationState(
  native: OrientationClient,
  options: {
    commanded: boolean
    milliseconds: number
    signal: AbortSignal
    maxRpcMs?: number
  },
) {
  const { commanded, milliseconds, signal, maxRpcMs = 30_000 } = options
  const deadline = Date.now() + milliseconds
  let ax: unknown
  let axError: string | undefined
  try {
    ax = await native.call('ax', {}, Math.min(milliseconds, maxRpcMs))
  } catch (error) {
    if (!(commanded && error instanceof Error && error.message === displayChanged)) {
      throw error
    }
    axError = String(error)
  }
  const remaining = deadline - Date.now()
  if (!(remaining > 0) || signal.aborted) {
    throw new Error(
      `Native orientation deadline exhausted; AX observation: ${axError ?? 'complete'}`,
    )
  }
  try {
    const apps = await native.call('apps', {}, Math.min(remaining, maxRpcMs))
    return { ax, apps, ...(axError ? { axError, pendingDisplayChange: true } : {}) }
  } catch (error) {
    if (axError) {
      throw new Error(`${String(error)}; preceding AX observation: ${axError}`, { cause: error })
    }
    throw error
  }
}

async function observation(
  native: OrientationClient,
  initial: InitialDisplay,
  options: {
    commanded: boolean
    milliseconds: number
    signal: AbortSignal
    maxRpcMs: number
    observe: Observe
  },
) {
  const deadline = Date.now() + options.milliseconds
  const state = await readOrientationState(native, options)
  const identity = nativeSafari(state.ax, state.apps)
  await options.observe({ phase: 'orientation-native-state', ...state, identity: identity ?? null })
  if (!identity) {
    if (state.pendingDisplayChange) {
      return
    }
    throw new Error('Native Safari identity unavailable during orientation operation')
  }
  if (identity.pid !== initial.safariPID) {
    throw new Error('Native Safari PID changed during orientation operation')
  }
  const screen = nativeDisplay(state.ax)
  const remaining = deadline - Date.now()
  if (!(remaining > 0)) {
    throw new Error('Native orientation deadline exhausted')
  }
  const rawOrientation = await native.call(
    'get-orientation',
    {},
    Math.min(remaining, options.maxRpcMs, 15_000),
  )
  const value = { screen, signature: displaySignature(screen), rawOrientation }
  await options.observe({ phase: 'orientation-observed', ...value })
  return value
}
function settle(
  native: OrientationClient,
  initial: InitialDisplay,
  target: Name,
  options: {
    milliseconds: number
    maxRpcMs?: number
    expectedSignature?: string
    observe: Observe
  },
) {
  let previous: string | undefined
  return until(async (signal, remaining) => {
    const value = await observation(native, initial, {
      commanded: true,
      milliseconds: remaining,
      signal,
      maxRpcMs: options.maxRpcMs ?? 30_000,
      observe: options.observe,
    })
    let displayMatches = false
    if (value) {
      if (options.expectedSignature) {
        displayMatches = value.signature === options.expectedSignature
      } else if (target === 'PORTRAIT') {
        displayMatches =
          value.screen.display.rotation === 0 && value.screen.height > value.screen.width
      } else {
        displayMatches =
          value.screen.display.rotation === 270 && value.screen.width > value.screen.height
      }
    }
    const matches = value && value.rawOrientation === target && displayMatches
    const signature = matches ? value.signature : undefined
    const repeated = signature !== undefined && previous === signature
    previous = signature
    return repeated ? value : undefined
  }, options.milliseconds / 1000)
}
/** Runs inside the existing bounded open phase, before the single game URL is attempted. */
export async function prepareOrientation(options: {
  native: OrientationClient
  udid: string
  ready: { ax: unknown; apps: unknown }
  target: Target
  milliseconds: number
  screenshot: (remaining: number) => Promise<unknown>
  capture: (initial: InitialDisplay) => Promise<void>
  observe: Observe
}) {
  const deadline = Date.now() + options.milliseconds
  const remaining = () => {
    const budget = deadline - Date.now()
    if (!(budget > 0)) {
      throw new Error('Native orientation preparation deadline exhausted')
    }
    return budget
  }
  const raw = await options.native.call('get-orientation', {}, Math.min(remaining(), 15_000))
  await options.observe({ phase: 'initial-raw-orientation', raw })
  const initial = initialDisplay(options.udid, options.ready, raw)
  await options.observe({ phase: 'initial-native-display', ...initial, ...options.ready })
  await options.capture(initial)
  await options.screenshot(remaining())
  initial.commandAttempted = true // Persist before a setter that could fail after a partial native write.
  await options.capture(initial)
  const acknowledgement = await options.native.call(
    'orientation',
    { value: options.target },
    Math.min(remaining(), 15_000),
  )
  await options.observe({
    phase: 'dedicated-orientation-command',
    requested: options.target,
    acknowledgement,
  })
  await settle(options.native, initial, options.target, {
    milliseconds: remaining(),
    observe: options.observe,
  })
  return initial
}
/** Restore the measured display only; never claim that native UNKNOWN was written back. */
export async function restoreDisplay(
  native: OrientationClient,
  initial: InitialDisplay,
  options: {
    milliseconds: number
    maxRpcMs: number
    observe?: Observe
  },
) {
  const { milliseconds, maxRpcMs, observe = () => undefined } = options
  const deadline = Date.now() + milliseconds
  if (!initial.commandAttempted) {
    throw new Error('No native orientation command requires restoration')
  }
  const remaining = () => {
    const budget = deadline - Date.now()
    if (!(budget > 0)) {
      throw new Error('Native display restoration deadline exhausted')
    }
    return budget
  }
  const acknowledgement = await native.call(
    'orientation',
    { value: initial.restoreName },
    Math.min(remaining(), maxRpcMs),
  )
  await observe({
    phase: 'restore-display-command',
    requested: initial.restoreName,
    acknowledgement,
  })
  const restored = await settle(native, initial, initial.restoreName, {
    milliseconds: remaining(),
    maxRpcMs,
    expectedSignature: initial.signature,
    observe,
  })
  return {
    displayRestored: restored.signature === initial.signature,
    contract: 'native-display',
    initial,
    restored,
    acknowledgement,
    rawOrientationRestored: restored.rawOrientation === initial.rawOrientation,
    limit: 'Native AX display restoration; raw UNKNOWN is not writable and is reported separately.',
  }
}

/** One Safari launch/identity proof, one dedicated orientation command, then the real game URL. */
export async function openOrientedSafari(options: {
  native: OrientationClient
  udid: string
  target: Target
  open: (remaining: number, signal: AbortSignal) => Promise<unknown>
  screenshot: (remaining: number) => Promise<unknown>
  capture: (initial: InitialDisplay) => Promise<void>
  beforeOpen: () => Promise<void>
  observe: Observe
  safariObserve: (event: SafariReadinessEvent) => Promise<void>
}) {
  let ready: { ax: unknown; apps: unknown } | undefined
  await openSafariWhenReady({
    launch: (remaining) => options.native.call('launch-safari', {}, remaining),
    read: async (remaining, signal) => {
      ready = await readSafariReadiness(
        {
          ax: (budget) => options.native.call('ax', {}, budget),
          apps: (budget) => options.native.call('apps', {}, budget),
        },
        remaining,
        signal,
      )
      return ready
    },
    open: async (remaining, signal) => {
      const deadline = Date.now() + remaining
      if (!ready) {
        throw new Error('Actual Safari readiness missing')
      }
      await prepareOrientation({ ...options, ready, milliseconds: remaining })
      const budget = deadline - Date.now()
      if (!(budget > 0)) {
        throw new Error('Native open phase deadline exhausted')
      }
      await options.beforeOpen()
      return options.open(budget, signal)
    },
    observe: options.safariObserve,
  })
}
