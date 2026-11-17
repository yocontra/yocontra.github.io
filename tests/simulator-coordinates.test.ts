import { expect, test as it, spyOn } from 'bun:test'
import { prepareCoordinates, startCoordinates } from '../tools/content/simulator-coordinates.ts'
import {
  actionablePoint,
  type CoordinatePage,
  coordinatePublication,
  type DocumentRun,
  documentOwner,
  measuredViewport,
  ownedHit,
  publishedPage,
  verifiedTouch,
} from '../tools/content/simulator-document.ts'
import { simulatorHost } from '../tools/content/simulator-host.ts'
import recorded from './fixtures/simulator-coordinate-v3.json' with { type: 'json' }

const run = recorded.run as DocumentRun
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('Missing recorded v3 fixture value')
  }
  return value
}
const fixture = () => {
  const f = structuredClone(recorded)
  const app = required(f.ax.elements[0])
  const doc = required(app.children[0])
  const title = required(doc.children[0])
  return { ...f, app, doc, title }
}
it('real v3 fields prove separate Safari/document ownership and a measured screen transform', () => {
  const f = fixture()
  const page = f.page as CoordinatePage
  const owner = documentOwner(f.ax, f.apps, page, run)
  expect(owner.safariPID).toBe(50_813)
  expect(owner.webViewPID).toBe(51_175)
  expect(owner.documentUUID).toBe('DE7FD0F8-F5AC-4AEA-A0F1-A0F957BED37A')
  const web = measuredViewport(owner, page)
  expect(web).toEqual({ x: 0, y: 50, width: 375, height: 664 })
  expect(ownedHit(f.hit, owner, f.pointLabel, f.point).pid).toBe(51_175)
  expect(actionablePoint(owner, run.startLabel)).toEqual({ x: 281, y: 118 })
  expect(() => actionablePoint(owner, run.canvasLabel)).toThrow('actionable point unavailable')
  expect(() => ownedHit(f.hit, owner, f.pointLabel, { x: 188, y: 339 })).toThrow('query target')
  expect(
    verifiedTouch(page, {
      after: required(page.qa.inputs[0]).sequence - 1,
      label: f.pointLabel,
      point: f.point,
      web,
    }).up.isTrusted,
  ).toBe(true)
})
it('real v3 publication requires a newer sequence and actual client/host freshness', () => {
  const f = fixture()
  const now = Math.max(f.page.qa.wall, f.receivedWall) + 1
  expect(publishedPage({ page: f.page, receivedWall: f.receivedWall }, run, now, 0)).toBe(f.page)
  expect(() =>
    publishedPage({ page: f.page, receivedWall: f.receivedWall }, run, now, f.page.qa.sequence),
  ).toThrow('stale')
  expect(() =>
    publishedPage({ page: f.page, receivedWall: f.receivedWall }, run, now + 30_001),
  ).toThrow('stale')
  expect(() => publishedPage({ page: f.page, receivedWall: now + 1 }, run, now)).toThrow('stale')
  f.page.url += '-wrong'
  expect(() => publishedPage({ page: f.page, receivedWall: now }, run, now)).toThrow()
})
it('real v3 owner rejects stale or duplicate native document/run identities', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.doc.identifier += '&WebViewProcessID=51175'
    },
    (f: ReturnType<typeof fixture>) => {
      f.doc.identifier = f.doc.identifier.replace('IsPageLoaded=true', 'IsPageLoaded=false')
    },
    (f: ReturnType<typeof fixture>) => {
      f.title.label += '-stale'
    },
    (f: ReturnType<typeof fixture>) => {
      f.apps.push(required(f.apps.find((app) => app.bundle_id === 'com.apple.mobilesafari')))
    },
  ]) {
    const f = fixture()
    mutate(f)
    expect(() => documentOwner(f.ax, f.apps, f.page as CoordinatePage, run)).toThrow()
  }
})
it('real v3 point PID, trusted events and actual canvas dimensions cannot be waived', () => {
  const f = fixture()
  const page = f.page as CoordinatePage
  const owner = documentOwner(f.ax, f.apps, page, run)
  const web = measuredViewport(owner, page)
  required(f.hit.elements[0]).pid = owner.safariPID
  expect(() => ownedHit(f.hit, owner, f.pointLabel, f.point)).toThrow()
  expect(() =>
    verifiedTouch(page, {
      after: required(page.qa.inputs[0]).sequence - 1,
      label: f.pointLabel,
      point: f.point,
      web: { ...web, y: 0 },
    }),
  ).toThrow()
  required(page.qa.inputs[0]).isTrusted = false
  expect(() =>
    verifiedTouch(page, {
      after: required(page.qa.inputs[0]).sequence - 1,
      label: f.pointLabel,
      point: f.point,
      web,
    }),
  ).toThrow()
  expect(() =>
    measuredViewport(owner, {
      ...page,
      canvas: { ...required(page.canvas ?? undefined), height: 500 },
    }),
  ).toThrow()
})
it('QA status refuses stale/foreign geometry or publications during recording', () => {
  const page = {
    ...recorded.page,
    url: `http://127.0.0.1:4398/experiments/out-west/frontier/?qaRun=${run.run}`,
  } as CoordinatePage
  expect(coordinatePublication(run.run, 'http://127.0.0.1:4398', page, {})).toBe(true)
  expect(coordinatePublication(run.run, 'https://elsewhere.example', page, {})).toBe(false)
  expect(coordinatePublication(run.run, 'http://127.0.0.1:4398', page, { page })).toBe(false)
  expect(
    coordinatePublication(run.run, 'http://127.0.0.1:4398', page, { stage: 'recording' }),
  ).toBe(false)
})
it('unknown native transport failure is fatal before focus/Start or coordinate fallback', async () => {
  const f = fixture()
  const error = new Error('UNAVAILABLE native channel')
  const page = { ...f.page, qa: { ...f.page.qa, wall: Date.now() } } as CoordinatePage
  let taps = 0
  await expect(
    prepareCoordinates(
      {
        read: () => Promise.reject(error),
        hit: () => Promise.reject(new Error('unexpected hit')),
        tap: () => {
          taps++
          return Promise.resolve()
        },
        status: () => Promise.resolve({ coordinates: { page, receivedWall: Date.now() } }),
        observe: () => Promise.resolve(),
      },
      run,
      'portrait',
    ),
  ).rejects.toBe(error)
  expect(taps).toBe(0)
})

/** Synthetic ordering around the retained real v3 owner; no native acceptance claim. */
function coordinateIO(fault?: 'owner' | 'geometry' | 'hit' | 'start-down') {
  const f = fixture()
  const events: string[] = []
  const page = f.page as CoordinatePage
  page.qa = { ...page.qa, sequence: 1, settledAfter: 0, inputs: [], wall: Date.now() }
  for (const [index, label] of ['FIRE', 'AIM', 'RELOAD'].entries()) {
    const control = structuredClone(required(f.title.children[2]))
    control.label = label
    control.frame = { x: 10 + index * 60, y: 150, width: 40, height: 40 }
    control.interactable = { status: 'actionable', at: { x: 30 + index * 60, y: 170 } }
    f.title.children.push(control)
    page.qa.controls[label] = { x: control.frame.x, y: 100, width: 40, height: 40 }
  }
  let reads = 0
  let taps = 0
  let statuses = 0
  const io = {
    read: () => {
      events.push('AX')
      reads++
      if (reads === 2) {
        // Safari moved its visible content after the focus touch. Only fresh AX can see this.
        for (const child of f.title.children) {
          child.frame.y += 20
          if (child.interactable.at) {
            child.interactable.at.y += 20
          }
        }
        if (fault === 'owner') {
          f.doc.identifier = f.doc.identifier.replace(
            'WebViewProcessID=51175',
            'WebViewProcessID=51176',
          )
        }
      }
      return Promise.resolve({ ax: f.ax, apps: f.apps })
    },
    hit: (point: { x: number; y: number }) => {
      events.push('hit')
      if (fault === 'hit') {
        return Promise.reject(new Error('UNAVAILABLE hit RPC'))
      }
      const anchor = f.title.children.find(
        (child) => child.interactable.at?.x === point.x && child.interactable.at.y === point.y,
      )
      return Promise.resolve({
        target: { kind: 'point', ...point },
        elements: [{ label: anchor?.label ?? run.canvasLabel, pid: 51_175 }],
      })
    },
    tap: (point: { x: number; y: number }) => {
      events.push('tap')
      taps++
      const label = taps === 1 ? run.canvasLabel : run.startLabel
      const after = page.qa.inputs.at(-1)?.sequence ?? 0
      const wall = Date.now()
      page.qa.inputs.push(
        ...['pointerdown', 'pointerup'].map((type, index) => ({
          sequence: after + index + 1,
          type,
          isTrusted: true,
          pointerType: 'touch',
          pointerId: taps,
          x: point.x,
          y: point.y - (taps === 1 ? 50 : 70),
          label,
          at: 10 + index,
          wall,
        })),
      )
      page.qa.sequence += 3
      page.qa.settledAfter = after + 2
      page.qa.wall = wall
      return Promise.resolve()
    },
    status: () => {
      events.push('DOM')
      statuses++
      const copy = structuredClone(page)
      if (fault === 'start-down' && taps === 2 && statuses === 4) {
        copy.qa.inputs.pop()
        copy.qa.sequence--
      }
      if (fault === 'geometry' && statuses === 3) {
        copy.qa.sequence++
      }
      return Promise.resolve({ coordinates: { page: copy, receivedWall: Date.now() } })
    },
    observe: () => Promise.resolve(),
  }
  return { io, events, taps: () => taps }
}
it('reads fresh native/settled DOM after focus and verifies Start at the new native point', async () => {
  const f = coordinateIO()
  const prepared = await prepareCoordinates(f.io, run, 'portrait')
  expect(f.events.slice(0, 7)).toEqual(['DOM', 'AX', 'hit', 'tap', 'DOM', 'AX', 'hit'])
  expect(prepared.web.y).toBe(70)
  expect(prepared.startPoint).toEqual({ x: 281, y: 138 })
  expect(prepared.buttons.FIRE.point).toEqual({ x: 30, y: 190 })
  const touch = await startCoordinates(f.io, prepared)
  expect(touch.down.label).toBe(run.startLabel)
  expect(touch.up.isTrusted).toBe(true)
  expect(f.taps()).toBe(2)
})
it('rejects owner changes and geometry publications during the native read without a Start tap', async () => {
  for (const fault of ['owner', 'geometry'] as const) {
    const f = coordinateIO(fault)
    await expect(prepareCoordinates(f.io, run, 'portrait')).rejects.toThrow(
      fault === 'owner' ? 'owner changed' : 'DOM geometry changed',
    )
    expect(f.taps()).toBe(1)
  }
})
it('does not turn an unknown native hit-test transport failure into a coordinate fallback', async () => {
  const f = coordinateIO('hit')
  await expect(prepareCoordinates(f.io, run, 'portrait')).rejects.toThrow('UNAVAILABLE hit RPC')
  expect(f.taps()).toBe(0)
})
it('host retains the final trusted Start publication but refuses new geometry after the clock starts', async () => {
  const id = run.run
  const host = simulatorHost('http://127.0.0.1:8798', '/unused-coordinate-no-file', {
    source: 'test',
    endSource: 'test',
    dirty: false,
    qaFlag: true,
    releaseEngine: true,
    contentManifestSha256: 'test',
    scripts: [],
  })
  const mockFetch = Object.assign(
    (input: Parameters<typeof fetch>[0]) =>
      Promise.resolve(
        Response.json(
          String(input).endsWith('performance-config')
            ? { fixture: true, voiceDisabled: true }
            : { accountId: 'local', token: 'synthetic' },
        ),
      ),
    { preconnect: fetch.preconnect },
  )
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(mockFetch)
  const post = (body: unknown) =>
    host(
      new Request(`http://127.0.0.1:4398/__qa/session/${id}`, {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:4398' },
        body: JSON.stringify(body),
      }),
    )
  const status = async () =>
    (await host(new Request(`http://127.0.0.1:4398/__qa/status/${id}`)))?.json()
  try {
    await host(new Request(`http://127.0.0.1:4398/__qa/start?id=${id}`))
    const page = fixture().page
    page.url = `http://127.0.0.1:4398/experiments/out-west/frontier/?server=remote&qaRun=${id}`
    expect((await post({ action: 'coordinates', page }))?.status).toBe(200)
    await post({ action: 'ready', page })
    expect(await status()).toMatchObject({ stage: 'ready', coordinates: { page } })
    expect((await post({ action: 'coordinates', page }))?.status).toBe(409)
    page.qa.sequence++
    expect((await post({ action: 'coordinates', page }))?.status).toBe(200)
    await post({ action: 'recording', recording: { running: true, frames: 1 } })
    const before = await status()
    expect(before).toMatchObject({ stage: 'recording', coordinates: { page } })
    page.qa.sequence++
    expect((await post({ action: 'coordinates', page }))?.status).toBe(409)
    expect(await status()).toEqual(before)
  } finally {
    mocked.mockRestore()
  }
})

it('waits for the trusted Start pointerup publication rather than accepting the earlier pointerdown', async () => {
  const f = coordinateIO('start-down')
  const prepared = await prepareCoordinates(f.io, run, 'portrait')
  const touch = await startCoordinates(f.io, prepared)
  expect(touch.up.type).toBe('pointerup')
  expect(f.taps()).toBe(2)
})
