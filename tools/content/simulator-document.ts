/** Recorder-only native document ownership and measured coordinate evidence. */
import { type Frame, nativeSafari, type PageState } from './simulator-native.ts'

export const COORDINATE_KEYS = [
  'AXLabel',
  'AXUniqueId',
  'AXValue',
  'title',
  'frame',
  'type',
  'pid',
  'hidden',
  'focused',
  'traits',
  'interactable',
]
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const decimal = /^[1-9]\d*$/u
const bidi = /^\u200e/u
const http = /^https?:\/\//u
export interface CoordinateInput {
  sequence: number
  type: string
  isTrusted: boolean
  pointerType: string
  pointerId: number
  x: number
  y: number
  label: string
  at: number
  wall: number
}
export interface CoordinatePage extends PageState {
  qa: {
    id: string
    documentTitle: string
    canvasLabel: string
    focusLabel: string
    startLabel: string
    sequence: number
    settledAfter: number
    at: number
    wall: number
    inputs: CoordinateInput[]
    controls: Record<string, Frame>
  }
}
function single<T>(values: T[], message: string): T {
  const value = values[0]
  if (values.length !== 1 || value === undefined) {
    throw new Error(message)
  }
  return value
}
interface Node {
  [key: string]: unknown
}
interface Path {
  node: Node
  ancestors: Node[]
}
export interface DocumentRun {
  run: string
  url: string
  title: string
  canvasLabel: string
  focusLabel: string
  startLabel: string
}
export function recordingDocument(id: string, url: string, start: string): DocumentRun {
  if (!uuid.test(id)) {
    throw new Error('Invalid coordinate run UUID')
  }
  return {
    run: id,
    url,
    title: `Out West recording [run:${id}]`,
    canvasLabel: `Out West game [run:${id}]`,
    focusLabel: `Focus recording [run:${id}]`,
    startLabel: `${start} [run:${id}]`,
  }
}
function paths(value: unknown): Path[] {
  const visit = (entry: unknown, ancestors: Node[]): Path[] => {
    if (Array.isArray(entry)) {
      return entry.flatMap((child) => visit(child, ancestors))
    }
    if (!entry || typeof entry !== 'object') {
      return []
    }
    const node = entry as Node
    return [{ node, ancestors }, ...visit(node.children, [...ancestors, node])]
  }
  return visit((value as { elements?: unknown } | null)?.elements, [])
}
export function coordinateFrame(value: unknown): value is Frame {
  const f = value as Frame | null
  return Boolean(
    f && [f.x, f.y, f.width, f.height].every(Number.isFinite) && f.width > 0 && f.height > 0,
  )
}
export function coordinateContains(frame: unknown, point: { x: number; y: number }) {
  return (
    coordinateFrame(frame) &&
    point.x >= frame.x &&
    point.x <= frame.x + frame.width &&
    point.y >= frame.y &&
    point.y <= frame.y + frame.height
  )
}
export function publishedPage(
  value: unknown,
  run: DocumentRun,
  now: number,
  after = 0,
): CoordinatePage {
  const saved = value as { page?: CoordinatePage; receivedWall?: number } | null
  const page = saved?.page
  const qa = page?.qa
  const receivedWall = saved?.receivedWall ?? Number.NaN
  if (
    !(page && qa) ||
    qa.id !== run.run ||
    page.url !== run.url ||
    qa.documentTitle !== run.title ||
    qa.canvasLabel !== run.canvasLabel ||
    qa.focusLabel !== run.focusLabel ||
    qa.startLabel !== run.startLabel ||
    page.visible !== 'visible' ||
    !page.focused ||
    !Number.isSafeInteger(qa.sequence) ||
    qa.sequence <= after ||
    !Array.isArray(qa.inputs) ||
    qa.inputs.length > 128 ||
    !Number.isSafeInteger(qa.settledAfter) ||
    qa.settledAfter < 0 ||
    !Number.isFinite(qa.at) ||
    !qa.controls ||
    typeof qa.controls !== 'object' ||
    !Number.isFinite(qa.wall) ||
    !Number.isFinite(receivedWall) ||
    now - qa.wall < -1000 ||
    now - qa.wall > 30_000 ||
    now - receivedWall < 0 ||
    now - receivedWall > 30_000
  ) {
    throw new Error('Coordinate page is missing, stale, hidden or belongs to a different run/URL')
  }
  return page
}
export function documentOwner(ax: unknown, apps: unknown, page: CoordinatePage, run: DocumentRun) {
  const identity = nativeSafari(ax, apps)
  if (
    !identity ||
    page.qa.id !== run.run ||
    page.url !== run.url ||
    page.qa.documentTitle !== run.title
  ) {
    throw new Error('Native Safari/current DOM identity unavailable')
  }
  const all = paths(ax)
  const docs = all.filter(({ node }) => node.type === 'TabDocumentView')
  const doc = single(docs, 'Current native TabDocument is missing or ambiguous')
  const identifier = doc.node.identifier
  if (
    doc.node.pid !== identity.pid ||
    typeof identifier !== 'string' ||
    !identifier.startsWith('TabDocument?') ||
    [...doc.ancestors, doc.node].some((node) => node.hidden === true)
  ) {
    throw new Error('Native document ancestry is foreign or hidden')
  }
  const fields = new URLSearchParams(identifier.slice('TabDocument?'.length))
  if (['UUID', 'WebViewProcessID', 'IsPageLoaded'].some((key) => fields.getAll(key).length !== 1)) {
    throw new Error('Missing or duplicate native document fields')
  }
  const documentUUID = fields.get('UUID') ?? ''
  const pid = fields.get('WebViewProcessID') ?? ''
  if (
    !uuid.test(documentUUID) ||
    fields.get('IsPageLoaded') !== 'true' ||
    !decimal.test(pid) ||
    !Number.isSafeInteger(Number(pid))
  ) {
    throw new Error('Native document is unloaded, stale or has an invalid WebView PID')
  }
  const titlePath = single(
    all.filter(({ node }) => node.label === run.title),
    'Native document marker missing or ambiguous',
  )
  const title = titlePath.node
  if (
    title.type !== 'WebAccessibilityObjectWrapper' ||
    title.pid !== identity.pid ||
    !titlePath.ancestors.includes(doc.node)
  ) {
    throw new Error('Native current run document marker unavailable')
  }
  for (const label of [run.canvasLabel, run.focusLabel, run.startLabel]) {
    const path = single(
      all.filter(({ node }) => node.label === label),
      'Native run anchor missing or ambiguous',
    )
    if (
      path.node.pid !== identity.pid ||
      !path.ancestors.includes(title) ||
      !path.ancestors.includes(doc.node) ||
      [...path.ancestors, path.node].some((node) => node.hidden === true)
    ) {
      throw new Error('Native canvas/Start run ancestry missing or hidden')
    }
  }
  const marker = `[run:${run.run}]`
  if (
    all.some(
      ({ node, ancestors }) =>
        ancestors.includes(doc.node) &&
        typeof node.label === 'string' &&
        node.label.includes('[run:') &&
        !node.label.includes(marker),
    )
  ) {
    throw new Error('Native document contains stale run markers')
  }
  const addresses = all.filter(({ node }) => node.label === 'Address')
  // Landscape Safari also reports the titles of inactive tabs as Address.
  const selected = addresses.filter(
    ({ node, ancestors }) =>
      node.type === 'Button' &&
      Array.isArray(node.traits) &&
      node.traits.includes('Selected') &&
      !node.traits.includes('TabButton') &&
      ancestors.some((parent) => parent.type === 'UnifiedTabBar'),
  )
  const addressPath = single(
    selected.length > 0 ? selected : addresses,
    'Native address observation missing or ambiguous',
  )
  if (
    addressPath.node.pid !== identity.pid ||
    typeof addressPath.node.value !== 'string' ||
    addressPath.ancestors.includes(doc.node) ||
    [...addressPath.ancestors, addressPath.node].some((node) => node.hidden === true)
  ) {
    throw new Error('Native address observation unavailable')
  }
  const address = addressPath.node.value.replace(bidi, '')
  const expected = new URL(run.url)
  if (
    http.test(address) ? address !== run.url : ![expected.host, expected.hostname].includes(address)
  ) {
    throw new Error('Native address contradicts actual current URL')
  }
  return {
    safariPID: identity.pid,
    webViewPID: Number(pid),
    documentUUID,
    nativeIdentifier: identifier,
    nativeAddress: address,
    URLProof: http.test(address)
      ? 'native full URL+markers'
      : 'native origin+current document/run markers+actual DOM URL',
    run,
    title,
    all,
  }
}
export type DocumentOwner = ReturnType<typeof documentOwner>
export function ownedAnchor(owner: DocumentOwner, label: string): Node & { frame: Frame } {
  const path = single(
    owner.all.filter(({ node }) => node.label === label),
    `Native owned anchor unavailable: ${label}`,
  )
  const bounds = path.node.frame
  if (
    !(path.ancestors.includes(owner.title) && coordinateFrame(bounds)) ||
    path.node.pid !== owner.safariPID ||
    [...path.ancestors, path.node].some((node) => node.hidden === true)
  ) {
    throw new Error(`Native owned anchor ancestry/frame unavailable: ${label}`)
  }
  return { ...path.node, frame: bounds }
}
export function actionablePoint(owner: DocumentOwner, label: string) {
  const anchor = ownedAnchor(owner, label)
  const interaction = anchor.interactable as {
    status?: string
    at?: { x?: number; y?: number }
  } | null
  const x = interaction?.at?.x
  const y = interaction?.at?.y
  if (
    interaction?.status !== 'actionable' ||
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    throw new Error(`Native actionable point unavailable: ${label}`)
  }
  return { x: Math.round(x), y: Math.round(y) }
}
export function ownedHit(
  hit: unknown,
  owner: DocumentOwner,
  label: string,
  point: { x: number; y: number },
) {
  const target = (hit as { target?: { kind?: string; x?: number; y?: number } } | null)?.target
  if (target?.kind !== 'point' || target.x !== point.x || target.y !== point.y) {
    throw new Error('Native hit query target does not match the requested screen point')
  }
  const all = paths(hit)
  const path = single(
    all.filter(({ node }) => node.label === label),
    'Native hit target missing or ambiguous',
  )
  if (
    path.node.pid !== owner.webViewPID ||
    all.some(
      ({ node }) => node.pid !== undefined && node.pid !== null && node.pid !== owner.webViewPID,
    )
  ) {
    throw new Error('Native hit target does not match the proved current document/anchor')
  }
  if (!coordinateContains(path.node.frame, point)) {
    throw new Error('Native hit frame does not contain the requested screen point')
  }
  return path.node
}
export function measuredViewport(owner: DocumentOwner, page: CoordinatePage): Frame {
  const native = ownedAnchor(owner, owner.run.canvasLabel).frame
  const css = page.canvas
  if (!(css && page.width > 0 && page.height > 0 && coordinateFrame(css))) {
    throw new Error('Actual canvas geometry unavailable')
  }
  const scale = native.width / css.width
  if (!(scale > 0) || Math.abs(native.height - css.height * scale) >= 4) {
    throw new Error('Native/CSS canvas aspect mismatch')
  }
  return {
    x: native.x - css.x * scale,
    y: native.y - css.y * scale,
    width: page.width * scale,
    height: page.height * scale,
  }
}
export function verifiedTouch(
  page: CoordinatePage,
  expected: { after: number; label: string; point: { x: number; y: number }; web: Frame },
) {
  const { after, label, point, web } = expected
  const inputs = page.qa.inputs.filter((input) => input.sequence > after)
  const down = inputs.find((input) => input.type === 'pointerdown')
  const up = inputs.find((input) => input.type === 'pointerup')
  const scale = web.width / page.width
  const x = (point.x - web.x) / scale
  const y = (point.y - web.y) / scale
  if (
    !(down && up) ||
    inputs.length !== 2 ||
    down.sequence !== after + 1 ||
    up.sequence !== down.sequence + 1 ||
    inputs.some(
      (input) =>
        !input.isTrusted ||
        input.pointerType !== 'touch' ||
        input.label !== label ||
        input.type === 'pointercancel',
    ) ||
    up.pointerId !== down.pointerId ||
    down.sequence >= up.sequence ||
    [down, up].some((input) => Math.hypot(input.x - x, input.y - y) > 5)
  ) {
    throw new Error('Trusted native touch does not match the measured coordinate target')
  }
  return { down, up }
}

export function coordinatePublication(
  id: string,
  origin: string | null,
  value: unknown,
  current: { page?: unknown; stage?: string },
) {
  const page = value as CoordinatePage | undefined
  const before = current.page as CoordinatePage | undefined
  if (
    !(
      page?.qa &&
      Number.isSafeInteger(page.qa.sequence) &&
      page.qa.sequence > (before?.qa.sequence ?? 0) &&
      Number.isFinite(page.qa.at) &&
      Number.isFinite(page.qa.wall) &&
      Array.isArray(page.qa.inputs)
    ) ||
    page.qa.inputs.length > 128 ||
    ['recording', 'saved', 'failed'].includes(current.stage ?? '')
  ) {
    return false
  }
  let url: URL
  try {
    url = new URL(page.url)
  } catch {
    return false
  }
  return (
    page.qa.id === id &&
    url.protocol === 'http:' &&
    url.searchParams.get('qaRun') === id &&
    origin === url.origin &&
    ['localhost', '127.0.0.1'].includes(url.hostname)
  )
}
