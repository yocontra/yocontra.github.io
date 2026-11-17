/** Native device/AX geometry guards shared by bounded simulator recording modes. */
import type { QARecorderPrivacySample } from './frame-recorder.ts'
import { nativeRendererCaptured } from './production-fixture.ts'

const decimalPID = /^[1-9]\d*$/u
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
  const node = nodes(value).find(
    (entry) => entry.AXLabel === label || entry.title === label || entry.label === label,
  )
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
export function webFrame(value: unknown, page?: PageState): Frame | undefined {
  if (
    page &&
    !(
      Number.isFinite(page.width) &&
      Number.isFinite(page.height) &&
      page.width > 0 &&
      page.height > 0 &&
      validFrame(page.canvas)
    )
  ) {
    return undefined
  }
  const frames = nodes(value).flatMap((entry) => {
    const frame = entry.frame ?? entry.AXFrame
    if (!validFrame(frame)) {
      return []
    }
    const legacy = ['WebArea', 'AXWebArea'].includes(
      String(entry.role ?? entry.AXRole ?? entry.type),
    )
    if (legacy) {
      return !page || Math.abs(frame.height - (page.height * frame.width) / page.width) < 4
        ? [frame]
        : []
    }
    const canvas = page?.canvas
    if (
      !(
        page &&
        canvas &&
        entry.type === 'WebAccessibilityObjectWrapper' &&
        entry.label === 'Out West game' &&
        Array.isArray(entry.traits) &&
        entry.traits.includes('WebContent') &&
        canvas.x >= 0 &&
        canvas.y >= 0 &&
        canvas.x + canvas.width <= page.width &&
        canvas.y + canvas.height <= page.height
      )
    ) {
      return []
    }
    const scale = frame.width / canvas.width
    if (Math.abs(frame.height - canvas.height * scale) >= 4) {
      return []
    }
    // Measured native game-canvas bounds and actual CSS canvas define the viewport transform.
    return [
      {
        x: frame.x - canvas.x * scale,
        y: frame.y - canvas.y * scale,
        width: page.width * scale,
        height: page.height * scale,
      },
    ]
  })
  const unique = new Map(
    frames.map((frame) => [[frame.x, frame.y, frame.width, frame.height].join(','), frame]),
  )
  return unique.size === 1 ? unique.values().next().value : undefined
}
function positivePID(value: unknown): number | undefined {
  const pid = typeof value === 'string' && decimalPID.test(value) ? Number(value) : value
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}
function nodePID(node: AXNode): number | undefined {
  const values = [node.pid, node.processIdentifier, node.process_id].filter(
    (v) => v !== null && v !== undefined,
  )
  const pids = values.map(positivePID)
  return pids.length > 0 && pids[0] !== undefined && pids.every((pid) => pid === pids[0])
    ? pids[0]
    : undefined
}
export function nativeSafari(
  value: unknown,
  apps?: unknown,
): { bundle: string; pid: number } | undefined {
  const envelope = value as { target?: { kind?: unknown } } | null
  if (envelope?.target !== undefined && envelope.target?.kind !== 'frontmost') {
    return undefined
  }
  const records = nodes(value).filter((node) =>
    ['Application', 'AXApplication'].includes(String(node.role ?? node.AXRole ?? node.type)),
  )
  const pid = records[0] && nodePID(records[0])
  const bundle = 'com.apple.mobilesafari'
  if (!pid || records.some((node) => nodePID(node) !== pid)) {
    return undefined
  }
  const inline = records.map((node) => node.bundleIdentifier ?? node.bundle_id ?? node.bundleID)
  if (inline.some((name) => name !== undefined && name !== bundle)) {
    return undefined
  }
  if (apps === undefined && inline.every((name) => name === bundle)) {
    return { bundle, pid } // Legacy native AX inline bundle contract.
  }
  if (envelope?.target?.kind !== 'frontmost' || !Array.isArray(apps)) {
    return undefined
  }
  const mappings = apps.filter((app): app is AXNode => app !== null && typeof app === 'object')
  const samePID = mappings.filter((app) =>
    [app.pid, app.processIdentifier, app.process_id].some((v) => positivePID(v) === pid),
  )
  const safari = mappings.filter((app) => app.bundle_id === bundle)
  const mapped = samePID[0]
  if (
    !mapped ||
    samePID.length !== 1 ||
    safari.length !== 1 ||
    mapped !== safari[0] ||
    nodePID(mapped) !== pid
  ) {
    return undefined
  }
  return { bundle, pid }
}
export function preflightIssues(options: {
  beforeAX: unknown
  afterAX: unknown
  beforeApps?: unknown
  afterApps?: unknown
  expectedURL: string
  receipt: unknown
  seconds?: 2 | 60
}) {
  const issues: string[] = []
  const first = nativeSafari(options.beforeAX, options.beforeApps)
  const last = nativeSafari(options.afterAX, options.afterApps)
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
/** LaunchCommand consumes everything after the app bundle as app arguments. */
export function safariLaunchArguments(idb: (...args: string[]) => string[]) {
  return [...idb('launch', '--foreground-if-running'), 'com.apple.mobilesafari']
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
