import { expect, test as it } from 'bun:test'
import { serve } from 'bun'
import { type CoordinatePage, recordingDocument } from '../tools/content/simulator-document.ts'
import { recordingOptions } from '../tools/content/simulator-hid.ts'
import { QA_DEVICE } from '../tools/content/simulator-native.ts'
import { captureNative } from '../tools/content/simulator-recording.ts'
import recorded from './fixtures/simulator-coordinate-v3.json' with { type: 'json' }

/** Real capture orchestration + local HTTP + retained native schema; no browser/native run. */
function captureFixture(failFinalAX: boolean, beforeFinalAX: () => void) {
  const raw = structuredClone(recorded)
  const startText = 'Start 60s 5 rider recording'
  const run = recordingDocument(raw.run.run, raw.page.url, startText)
  const replacements = [
    [raw.run.title, run.title],
    [raw.run.canvasLabel, run.canvasLabel],
    [raw.run.startLabel, run.startLabel],
    [raw.pointLabel, run.focusLabel],
  ] as const
  let encoded = JSON.stringify(raw.ax)
  for (const [before, after] of replacements) {
    encoded = encoded.replaceAll(before, after)
  }
  const ax = JSON.parse(encoded) as typeof raw.ax
  const title = ax.elements[0]?.children[0]?.children[0]
  if (!title) {
    throw new Error('Recorded native document missing')
  }
  const page = structuredClone(raw.page) as CoordinatePage
  page.qa = {
    ...page.qa,
    documentTitle: run.title,
    canvasLabel: run.canvasLabel,
    focusLabel: run.focusLabel,
    startLabel: run.startLabel,
    sequence: 1,
    settledAfter: 0,
    inputs: [],
    controls: {},
    wall: Date.now(),
  }
  for (const label of [run.focusLabel, run.startLabel]) {
    const anchor = title.children.find((child) => child.label === label)
    if (!anchor) {
      throw new Error('Recorded native control missing')
    }
    page.qa.controls[label] = { ...anchor.frame, y: anchor.frame.y - 50 }
  }
  for (const [index, label] of ['FIRE', 'AIM', 'RELOAD'].entries()) {
    const original = title.children[2]
    if (!original) {
      throw new Error('Recorded native control template missing')
    }
    const anchor = structuredClone(original)
    anchor.label = label
    anchor.frame = { x: 10 + index * 60, y: 150, width: 40, height: 40 }
    anchor.interactable = { status: 'actionable', at: { x: 30 + index * 60, y: 170 } }
    title.children.push(anchor)
    page.qa.controls[label] = { ...anchor.frame, y: 100 }
  }
  const calls: {
    op: string
    args: Record<string, unknown> | undefined
    timeout: number | undefined
  }[] = []
  let started = false
  let delivered = false
  let taps = 0
  let orientation = 'UNKNOWN'
  const clock = { at: 1000, wall: Date.now() }
  const receipt = {
    recording: {
      timestamps: [1000, 1016],
      inputs: [],
      samples: [],
      completed: false,
      resources: [],
    },
    scriptHashes: [],
    preflight: false,
  }
  const readAX = (): Promise<unknown> => {
    if (delivered) {
      beforeFinalAX()
      if (failFinalAX) {
        return Promise.reject(new Error('Native accessibility deadline exceeded'))
      }
    }
    return Promise.resolve(ax)
  }
  return {
    run,
    page,
    ax,
    calls,
    receipt,
    clock,
    status: () => ({
      stage: started ? 'recording' : 'ready',
      page,
      coordinates: { page, receivedWall: Date.now() },
      wall: Date.now(),
      ...(started ? { recording: { running: true, frames: 1, ...clock } } : {}),
      ...(delivered ? { receipt } : {}),
    }),
    native: {
      call: (op: string, args?: Record<string, unknown>, timeout?: number): Promise<unknown> => {
        calls.push({ op, args, timeout })
        if (op === 'ax') {
          return readAX()
        }
        if (op === 'apps') {
          return Promise.resolve(raw.apps)
        }
        if (op === 'get-orientation') {
          return Promise.resolve(orientation)
        }
        if (op === 'orientation') {
          orientation = String(args?.value)
          return Promise.resolve(orientation)
        }
        if (op === 'launch-safari' || op === 'screenshot') {
          return Promise.resolve(true)
        }
        if (op === 'record') {
          delivered = true
          return Promise.resolve({ tapeAccepted: true })
        }
        const point = { x: Number(args?.x), y: Number(args?.y) }
        const anchor = title.children.find(
          (child) => child.interactable.at?.x === point.x && child.interactable.at.y === point.y,
        )
        if (!anchor) {
          return Promise.reject(new Error('No native anchor at supplied point'))
        }
        if (op === 'hit') {
          return Promise.resolve({
            target: { kind: 'point', ...point },
            elements: [{ label: anchor.label, pid: 51_175, frame: anchor.frame }],
          })
        }
        if (op !== 'tap') {
          return Promise.reject(new Error(`Unexpected operation ${op}`))
        }
        const after = page.qa.inputs.at(-1)?.sequence ?? 0
        taps++
        page.qa.inputs.push(
          ...['pointerdown', 'pointerup'].map((type, i) => ({
            sequence: after + i + 1,
            type,
            isTrusted: true,
            pointerType: 'touch',
            pointerId: taps,
            x: point.x,
            y: point.y - 50,
            label: anchor.label,
            at: 10 + i,
            wall: Date.now(),
          })),
        )
        page.qa.sequence += 3
        page.qa.settledAfter = after + 2
        page.qa.wall = Date.now()
        started = anchor.label === run.startLabel
        clock.wall = Date.now()
        return Promise.resolve(true)
      },
    },
  }
}

it.each([
  ['sends the complete tape after host readiness', false],
  ['keeps the browser receipt when the final accessibility read times out', true],
] as const)('%s', async (_scenario, failFinalAX) => {
  expect(Reflect.has(globalThis, 'orientation')).toBe(false)
  const checkpoints: Record<string, unknown>[] = []
  const fixture = captureFixture(failFinalAX, () => {
    expect(checkpoints.at(-1)?.browserReceipt).toEqual(fixture.receipt)
  })
  let statusReads = 0
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      ++statusReads === 1
        ? new Response('Not ready', { status: 404 })
        : Response.json(fixture.status()),
  })
  fixture.page.url = new URL('/experiments/out-west/frontier/', server.url).href
  let opens = 0
  try {
    const result = await captureNative({
      native: fixture.native,
      run: () => {
        opens++
        return Promise.resolve('opened once')
      },
      open: ['offline URL action'],
      stateURL: new URL(`/__qa/status/${fixture.run.run}`, server.url),
      selected: recordingOptions('ordinary', 'portrait'),
      output: '/unused-offline-native-capture',
      checkpoint: (value) => {
        checkpoints.push(structuredClone(value))
        return Promise.resolve()
      },
      orientation: {
        udid: QA_DEVICE,
        capture: () => Promise.resolve(),
        beforeOpen: () => Promise.resolve(),
      },
    })
    const acknowledged = checkpoints.find((value) => value.recordingAcknowledgement)
    expect(acknowledged?.orientation).toBe('PORTRAIT')
    expect(result.orientation).toBe('PORTRAIT')
    expect(opens).toBe(1)
    expect(statusReads).toBeGreaterThan(1)
    const records = fixture.calls.filter((call) => call.op === 'record')
    expect(records).toHaveLength(1)
    expect(records[0]?.timeout).toBe(75_000)
    expect(records[0]?.args?.clock).toEqual({ running: true, frames: 1, ...fixture.clock })
    expect(records[0]?.args?.tape).toEqual(result.tape)
    expect(acknowledged?.tape).toEqual(result.tape)
    expect(result.tape).toHaveLength(54)
    expect(result.tape.map((gesture) => gesture.id)).toEqual(
      Array.from({ length: 54 }, (_, i) => i),
    )
    expect(result.tape[0]?.at).toBe(fixture.clock.at + 1500)
    expect(
      result.tape.every((gesture) => gesture.at + gesture.duration < fixture.clock.at + 60_000),
    ).toBe(true)
    expect(new Set(result.tape.map((gesture) => gesture.role))).toEqual(
      new Set(['move', 'look', 'FIRE', 'AIM', 'RELOAD']),
    )
    expect(result.receipt).toEqual(fixture.receipt)
    expect(result.afterAX).toEqual(failFinalAX ? null : fixture.ax)
    expect(result.afterApps).toEqual(recorded.apps)
    expect(result.nativeFailure).toBe(
      failFinalAX
        ? 'Final native accessibility read: Error: Native accessibility deadline exceeded'
        : null,
    )
    expect(fixture.calls.filter((call) => call.op === 'launch-safari')).toHaveLength(1)
  } finally {
    await server.stop(true)
  }
})
