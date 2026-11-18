/** Bounded preparation shared by actual two-second and sixty-second native recorder modes. */

import {
  actionablePoint,
  type CoordinatePage,
  coordinateContains,
  type DocumentOwner,
  type DocumentRun,
  documentOwner,
  measuredViewport,
  ownedAnchor,
  ownedHit,
  publishedPage,
  verifiedTouch,
} from './simulator-document.ts'
import { nativeTransform } from './simulator-hid.ts'
import { bounded, until } from './simulator-process.ts'

interface CoordinateIO {
  read: () => Promise<{ ax: unknown; apps: unknown }>
  hit: (point: { x: number; y: number }) => Promise<unknown>
  tap: (point: { x: number; y: number }) => Promise<unknown>
  status: (signal: AbortSignal) => Promise<unknown>
  observe: (value: Record<string, unknown>) => Promise<void>
}
function currentPage(
  io: CoordinateIO,
  run: DocumentRun,
  after = 0,
  touch: 'none' | 'up' | 'settled' = 'none',
) {
  return until(async (signal) => {
    const state = (await io.status(signal)) as {
      stage?: string
      error?: string
      coordinates?: unknown
    }
    if (state.stage === 'failed') {
      throw new Error(state.error ?? 'Local QA page failed')
    }
    if (!state.coordinates) {
      return
    }
    const candidate = state.coordinates as { page?: CoordinatePage }
    if ((candidate.page?.qa?.sequence ?? Number.POSITIVE_INFINITY) <= after) {
      return
    }
    const page = publishedPage(state.coordinates, run, Date.now(), after)
    const up = page.qa.inputs.at(-1)
    if (
      (touch !== 'none' && up?.type !== 'pointerup') ||
      (touch === 'settled' && up && page.qa.settledAfter < up.sequence)
    ) {
      return
    }
    return page
  }, 5)
}
function ownerReceipt(owner: DocumentOwner) {
  const { safariPID, webViewPID, documentUUID, nativeIdentifier, nativeAddress, URLProof } = owner
  return { safariPID, webViewPID, documentUUID, nativeIdentifier, nativeAddress, URLProof }
}
export async function prepareCoordinates(io: CoordinateIO, run: DocumentRun, orientation: string) {
  const initialPage = await currentPage(io, run)
  const initial = await io.read()
  const initialOwner = documentOwner(initial.ax, initial.apps, initialPage, run)
  const initialWeb = measuredViewport(initialOwner, initialPage)
  const transform = nativeTransform(initialWeb, initialPage, orientation)
  const focus = actionablePoint(initialOwner, run.focusLabel)
  await io.observe({
    phase: 'focus-query',
    ...initial,
    page: initialPage,
    owner: ownerReceipt(initialOwner),
    web: initialWeb,
    focus,
  })
  const focusHit = await io.hit(focus)
  await io.observe({ phase: 'focus-hit', focusHit })
  ownedHit(focusHit, initialOwner, run.focusLabel, focus)
  if (!coordinateContains(initialPage.qa.controls[run.focusLabel], transform.css(focus))) {
    throw new Error('Native focus point disagrees with actual DOM geometry')
  }
  await io.tap(focus)
  const page = await currentPage(io, run, initialPage.qa.sequence, 'settled')
  const focusTouch = verifiedTouch(page, {
    after: initialPage.qa.inputs.at(-1)?.sequence ?? 0,
    label: run.focusLabel,
    point: focus,
    web: initialWeb,
  })
  const fresh = await io.read() // Deliberately after the trusted focus and settled DOM publication.
  const owner = documentOwner(fresh.ax, fresh.apps, page, run)
  if (
    owner.safariPID !== initialOwner.safariPID ||
    owner.webViewPID !== initialOwner.webViewPID ||
    owner.documentUUID !== initialOwner.documentUUID
  ) {
    throw new Error('Native document owner changed during focus')
  }
  const web = measuredViewport(owner, page)
  const measured = nativeTransform(web, page, orientation)
  const control = async (label: string) => {
    const point = actionablePoint(owner, label)
    const hit = await io.hit(point)
    ownedHit(hit, owner, label, point)
    const css = measured.css(point)
    const rect = page.qa.controls[label]
    if (!coordinateContains(rect, css)) {
      throw new Error('Native HUD point disagrees with actual DOM geometry')
    }
    await io.observe({ phase: 'HUD-point', label, point, hit })
    return { ...ownedAnchor(owner, label).frame, point }
  }
  const buttons = {
    FIRE: await control('FIRE'),
    AIM: await control('AIM'),
    RELOAD: await control('RELOAD'),
  }
  const startPoint = actionablePoint(owner, run.startLabel)
  const startHit = await io.hit(startPoint)
  ownedHit(startHit, owner, run.startLabel, startPoint)
  const latest = await currentPage(io, run)
  if (latest.qa.sequence !== page.qa.sequence) {
    throw new Error('DOM geometry changed while native coordinates were read')
  }
  const prepared = {
    ...fresh,
    page,
    web,
    buttons,
    startPoint,
    run,
    owner: ownerReceipt(owner),
    focusTouch,
    startHit,
  }
  await io.observe({ phase: 'prepared', ...prepared })
  return prepared
}
export async function startCoordinates(
  io: CoordinateIO,
  prepared: Awaited<ReturnType<typeof prepareCoordinates>>,
) {
  await io.tap(prepared.startPoint)
  const page = await currentPage(io, prepared.run, prepared.page.qa.sequence, 'up')
  const touch = verifiedTouch(page, {
    after: prepared.page.qa.inputs.at(-1)?.sequence ?? 0,
    label: prepared.run.startLabel,
    point: prepared.startPoint,
    web: prepared.web,
  })
  await io.observe({ phase: 'Start-touch', page, touch })
  return touch
}
export function coordinateStatus(url: URL, signal: AbortSignal): Promise<unknown> {
  return bounded(async (abort) => {
    const response = await fetch(url, { signal: AbortSignal.any([signal, abort]) })
    if (response.status !== 200) {
      throw new Error(`Coordinate status HTTP ${response.status}`)
    }
    return response.json() as Promise<unknown>
  }, 5000)
}
