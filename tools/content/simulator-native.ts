/** Native device/AX geometry guards shared by bounded simulator recording modes. */
import type { QARecorderPrivacySample } from './frame-recorder.ts'
import { nativeRendererCaptured } from './production-fixture.ts'

const deviceId = /^[0-9A-F-]{36}$/iu
export const QA_DEVICE = '59616A95-4749-4F6F-8E1D-1FAEA0263EFC'
export interface Frame {
  x: number
  y: number
  width: number
  height: number
}
export interface PageState {
  url: string
  visible: string
  focused: boolean
  width: number
  height: number
  canvas: Frame | null
}
interface AXNode {
  frame?: Frame
  title?: string
  role?: string
  type?: string
  [key: string]: unknown
}
export function targetForPreflight(list: unknown, udid: string) {
  const devices = (
    list as {
      devices?: Record<
        string,
        {
          udid: string
          state: string
          name: string
          deviceTypeIdentifier?: string
          isAvailable?: boolean
        }[]
      >
    }
  ).devices
  const target = Object.values(devices ?? {})
    .flat()
    .find((device) => device.udid === udid)
  if (
    !target ||
    target.isAvailable === false ||
    target.state !== 'Shutdown' ||
    target.deviceTypeIdentifier !== 'com.apple.CoreSimulator.SimDeviceType.iPhone-13-mini' ||
    !target.name.includes('Out West QA')
  ) {
    throw new Error(
      'Preflight requires an available shutdown Out West QA iPhone 13 mini; existing sessions are untouched',
    )
  }
  return target
}
/** Installed idb list-apps prints one JSON object per line, unlike describe-all. */
export function parseIDBApps(stdout: string): unknown[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown)
}
export function preflightURL(origin: string, id: string) {
  const url = new URL(origin)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('Preflight accepts only the local QA production host')
  }
  url.pathname = '/__qa/start'
  url.search = new URLSearchParams({ id, preflight: '1' }).toString()
  return url.href
}
function nodes(value: unknown): AXNode[] {
  if (!value || typeof value !== 'object') {
    return []
  }
  if (Array.isArray(value)) {
    return value.flatMap(nodes)
  }
  return [value as AXNode, ...Object.values(value).flatMap(nodes)]
}
export function frameForAX(value: unknown, label: string): Frame | undefined {
  const node = nodes(value).find((entry) => entry.AXLabel === label || entry.title === label)
  const frame = node?.frame ?? node?.AXFrame
  return validFrame(frame) ? frame : undefined
}
function validFrame(value: unknown): value is Frame {
  const frame = value as Frame | undefined
  return Boolean(
    frame &&
      [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) &&
      frame.width > 0 &&
      frame.height > 0,
  )
}
export function webFrame(value: unknown): Frame | undefined {
  const node = nodes(value).find((entry) =>
    ['WebArea', 'AXWebArea'].includes(String(entry.role ?? entry.AXRole ?? entry.type)),
  )
  const frame = node?.frame ?? node?.AXFrame
  return validFrame(frame) ? frame : undefined
}
export function nativeSafari(value: unknown): { bundle: string; pid: number } | undefined {
  // Only native application records from the frontmost-app AX read count; labels/RUNNING do not.
  for (const node of nodes(value)) {
    if (!['Application', 'AXApplication'].includes(String(node.role ?? node.AXRole ?? node.type))) {
      continue
    }
    const bundle = node.bundleIdentifier ?? node.bundle_id ?? node.bundleID
    const pid = node.pid ?? node.processIdentifier ?? node.process_id
    if (bundle === 'com.apple.mobilesafari' && typeof pid === 'number' && pid > 0) {
      return { bundle, pid }
    }
  }
  return undefined
}
export function preflightIssues(options: {
  beforeAX: unknown
  afterAX: unknown
  expectedURL: string
  receipt: unknown
  seconds?: 2 | 60
}) {
  const issues: string[] = []
  const first = nativeSafari(options.beforeAX)
  const last = nativeSafari(options.afterAX)
  if (!(first && last) || first.pid !== last.pid) {
    issues.push('Native guest foreground Safari identity unavailable or changed')
  }
  const receipt = options.receipt as {
    preflight?: boolean
    recording?: {
      completed?: boolean
      inputs?: { type: string }[]
      timestamps?: number[]
      samples?: {
        privacy?: QARecorderPrivacySample
        game?: { scene: { renderer?: Parameters<typeof nativeRendererCaptured>[0] } }
        url?: string
        visible: string
        focused: boolean
        audio: { state: string }[]
        contexts: { lost: boolean; buffer: { width: number; height: number } }[]
      }[]
    }
  }
  const recording = receipt.recording
  if (recording?.samples?.some((sample) => !nativeRendererCaptured(sample.game?.scene.renderer))) {
    issues.push('Actual native renderer tier/post configuration was not captured')
  }
  if (recording?.samples?.some((sample) => sample.privacy?.graphics?.applied !== 'auto')) {
    issues.push('Temporary QA graphics selection was not auto')
  }
  const matchingMode =
    (options.seconds ?? 2) === 2 ? receipt.preflight : receipt.preflight === false
  if (!(matchingMode && recording?.completed && (recording.timestamps?.length ?? 0) >= 30)) {
    issues.push(
      (options.seconds ?? 2) === 2
        ? 'Two-second native frame capability not established'
        : 'Completed native recording not established',
    )
  }
  if (!recording?.inputs?.some((input) => input.type === 'pointerdown')) {
    issues.push('Trusted guest HID pointer input missing')
  }
  if (
    !recording?.samples?.length ||
    recording.samples.some(
      (sample) =>
        !(sample.privacy?.captureBlocked && sample.privacy.voiceChatForcedOff) ||
        sample.privacy.captureCalls !== 0,
    )
  ) {
    issues.push('Capture prevention missing or microphone capture attempted')
  }
  if (
    !recording?.samples?.length ||
    recording.samples.some(
      (sample) =>
        sample.visible !== 'visible' || !sample.focused || sample.url !== options.expectedURL,
    )
  ) {
    issues.push('Guest page URL/visibility/focus not established')
  }
  if (
    !recording?.samples?.length ||
    recording.samples.some((sample) => !sample.audio.some((audio) => audio.state === 'running'))
  ) {
    issues.push('Guest game audio not running')
  }
  if (
    !recording?.samples?.length ||
    recording.samples.some(
      (sample) =>
        sample.contexts.length === 0 ||
        sample.contexts.some(
          (context) => context.lost || context.buffer.width <= 0 || context.buffer.height <= 0,
        ),
    )
  ) {
    issues.push('Guest native graphics capability missing')
  }
  return issues
}
/** idb treats decimal coordinate tokens as markers; HID targets must be integer points. */
export function hidTapArguments(x: number, y: number) {
  if (![x, y].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('Invalid guest HID point')
  }
  return [
    'ui',
    'tap',
    String(Math.round(x)),
    String(Math.round(y)),
    '--api',
    'hid',
    '--duration',
    '0.15',
  ]
}
export function commandPlan(udid: string, url: string, port: number) {
  if (!(deviceId.test(udid) && Number.isInteger(port)) || port < 1024 || port > 65_535) {
    throw new Error('Invalid simulator target/port')
  }
  return {
    boot: ['xcrun', 'simctl', 'boot', udid],
    ready: ['xcrun', 'simctl', 'bootstatus', udid],
    readyTimeoutMs: 180_000,
    companion: ['idb_companion', '--udid', udid, '--grpc-port', String(port), '--headless', '1'],
    open: ['xcrun', 'simctl', 'openurl', udid, url],
    shutdown: ['xcrun', 'simctl', 'shutdown', udid],
  }
}
