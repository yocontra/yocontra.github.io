import { expect, test as it } from 'bun:test'
import { QA_DEVICE } from '../tools/content/simulator-native.ts'
import {
  displaySignature,
  type InitialDisplay,
  initialDisplay,
  nativeDisplay,
  openOrientedSafari,
  prepareOrientation,
  readOrientationState,
  restoreDisplay,
} from '../tools/content/simulator-orientation.ts'
import fixture from './fixtures/simulator-coordinate-v3.json' with { type: 'json' }

const changed = 'Simulator display changed during the operation'
function nativeFixture() {
  const ax = structuredClone(fixture.ax)
  let raw = 'UNKNOWN'
  const calls: string[] = []
  const pending: Error[] = []
  let setterFailure: Error | undefined
  let ignoreSetter = false
  const setRequested = (args?: Record<string, unknown>) => {
    if (!ignoreSetter) {
      raw = String(args?.value)
      const landscape = raw === 'LANDSCAPE_LEFT'
      ax.screen.display.rotation = landscape ? 270 : 0
      ax.screen.width = landscape ? 812 : 375
      ax.screen.height = landscape ? 375 : 812
    }
    return setterFailure
      ? Promise.reject(setterFailure)
      : Promise.resolve({ requested: args?.value, observed: raw })
  }
  return {
    calls,
    pending,
    ax,
    setRaw: (value: string) => {
      raw = value
    },
    failSetter: (error: Error) => {
      setterFailure = error
    },
    ignoreSetter: () => {
      ignoreSetter = true
    },
    call: (op: string, args?: Record<string, unknown>) => {
      calls.push(op)
      if (op === 'ax') {
        const error = pending.shift()
        if (error) {
          return Promise.reject(error)
        }
        return Promise.resolve(structuredClone(ax))
      }
      if (op === 'apps') {
        return Promise.resolve(fixture.apps)
      }
      if (op === 'get-orientation') {
        return Promise.resolve(raw)
      }
      if (op === 'orientation') {
        return setRequested(args)
      }
      if (op === 'launch-safari') {
        return Promise.resolve({ launched: true })
      }
      throw new Error(`Unexpected offline operation ${op}`)
    },
  }
}
function initial(raw = 'UNKNOWN') {
  return initialDisplay(QA_DEVICE, fixture, raw)
}
const signal = () => new AbortController().signal
const observe = () => undefined

it('keeps recorded native UNKNOWN separate from measured dedicated-device display mappings', () => {
  const value = initial()
  expect(value.rawOrientation).toBe('UNKNOWN')
  expect(value.screen).toEqual(nativeDisplay(fixture.ax))
  expect(value.safariPID).toBe(50_813)
  expect(value.restoreName).toBe('PORTRAIT')
  expect(value.restoreBasis).toBe('measured dedicated-device AX mapping')
  const landscape = structuredClone(fixture)
  landscape.ax.screen.width = 812
  landscape.ax.screen.height = 375
  landscape.ax.screen.display.rotation = 270
  expect(initialDisplay(QA_DEVICE, landscape, 'UNKNOWN').restoreName).toBe('LANDSCAPE_LEFT')
  landscape.ax.screen.display.rotation = 90
  expect(() => initialDisplay(QA_DEVICE, landscape, 'UNKNOWN')).toThrow('No measured')
  expect(() => initialDisplay('other-device', fixture, 'UNKNOWN')).toThrow('Restorable')
  expect(() => initial('FACE_UP')).toThrow('Restorable')
  expect(initial('LANDSCAPE_RIGHT').restoreBasis).toBe('native getter')
  expect(() => initialDisplay(QA_DEVICE, { ax: fixture.ax, apps: [] }, 'UNKNOWN')).toThrow(
    'identity',
  )
  expect(() => nativeDisplay({ screen: { ...fixture.ax.screen, width: Number.NaN } })).toThrow(
    'geometry',
  )
  expect(() =>
    nativeDisplay({ screen: { ...fixture.ax.screen, coordinate_space: 'client' } }),
  ).toThrow('geometry')
})

it('permits only the exact commanded display-snapshot error and preserves independent app evidence', async () => {
  const native = nativeFixture()
  native.pending.push(new Error(changed))
  const state = await readOrientationState(native, {
    commanded: true,
    milliseconds: 1000,
    signal: signal(),
  })
  expect(state.pendingDisplayChange).toBe(true)
  expect(state.axError).toBe(`Error: ${changed}`)
  expect(state.apps).toEqual(fixture.apps)
  expect(native.calls).toEqual(['ax', 'apps'])
  for (const [commanded, message] of [
    [false, changed],
    [true, `${changed}.`],
    [true, 'native transport disconnected'],
    [
      true,
      'axbridge could not resolve the frontmost application using the window-server strategy: window-server frontmost returned no application object',
    ],
  ] as const) {
    native.calls.length = 0
    native.pending.push(new Error(message))
    await expect(
      readOrientationState(native, { commanded, milliseconds: 100, signal: signal() }),
    ).rejects.toThrow(message)
    expect(native.calls).toEqual(['ax'])
  }
  await expect(
    readOrientationState(
      {
        call: (op) =>
          op === 'ax'
            ? Promise.reject(new Error(changed))
            : Promise.reject(new Error('apps RPC failed')),
      },
      {
        commanded: true,
        milliseconds: 100,
        signal: signal(),
      },
    ),
  ).rejects.toThrow(`apps RPC failed; preceding AX observation: Error: ${changed}`)
})

it('uses one dedicated setter and observes the actual requested enum and display before URL open', async () => {
  const native = nativeFixture()
  const order: string[] = []
  const saved: InitialDisplay[] = []
  await openOrientedSafari({
    native: {
      call: (op, args) => {
        order.push(op)
        return native.call(op, args)
      },
    },
    udid: QA_DEVICE,
    target: 'LANDSCAPE_LEFT',
    screenshot: () => {
      order.push('initial PNG')
      return Promise.resolve()
    },
    capture: (value) => {
      saved.push(structuredClone(value))
      return Promise.resolve()
    },
    beforeOpen: () => {
      order.push('URL attempted')
      return Promise.resolve()
    },
    open: () => {
      order.push('actual URL')
      return Promise.resolve()
    },
    safariObserve: () => Promise.resolve(),
    observe,
  })
  expect(order[0]).toBe('launch-safari')
  expect(order.indexOf('apps')).toBeLessThan(order.indexOf('initial PNG'))
  expect(order.indexOf('initial PNG')).toBeLessThan(order.indexOf('orientation'))
  expect(order.at(-1)).toBe('actual URL')
  expect(order.filter((op) => op === 'orientation')).toHaveLength(1)
  expect(order.filter((op) => op === 'ax')).toHaveLength(3)
  expect(saved.map((value) => value.commandAttempted)).toEqual([false, true])
  expect(saved[0]?.rawOrientation).toBe('UNKNOWN')
  expect(native.ax.screen.display.rotation).toBe(270)
  expect(native.calls).not.toContain('rotate')
})

it('retains exact pending observations then settles; a partial setter failure cannot open the URL', async () => {
  const native = nativeFixture()
  native.pending.push(new Error(changed))
  const rows: Record<string, unknown>[] = []
  await prepareOrientation({
    native,
    udid: QA_DEVICE,
    ready: fixture,
    target: 'PORTRAIT',
    milliseconds: 1500,
    screenshot: () => Promise.resolve(),
    capture: () => Promise.resolve(),
    observe: (row) => {
      rows.push(row)
    },
  })
  expect(rows.some((row) => row.pendingDisplayChange === true)).toBe(true)
  const failed = nativeFixture()
  failed.failSetter(new Error('setter transport failed after write'))
  const saved: InitialDisplay[] = []
  let opened = false
  await expect(
    openOrientedSafari({
      native: failed,
      udid: QA_DEVICE,
      target: 'PORTRAIT',
      screenshot: () => Promise.resolve(),
      capture: (value) => {
        saved.push(structuredClone(value))
        return Promise.resolve()
      },
      beforeOpen: () => {
        opened = true
        return Promise.resolve()
      },
      open: () => Promise.resolve(),
      observe,
      safariObserve: () => Promise.resolve(),
    }),
  ).rejects.toThrow('setter transport failed after write')
  expect(opened).toBe(false)
  expect(saved.at(-1)?.commandAttempted).toBe(true)
  expect(failed.calls.filter((op) => op === 'orientation')).toHaveLength(1)
})

it('does not settle on a guessed enum, wrong geometry, ambiguous identity or a different Safari PID', async () => {
  for (const failure of ['UNKNOWN', 'geometry', 'ambiguous', 'PID'] as const) {
    const native = nativeFixture()
    if (failure === 'UNKNOWN' || failure === 'geometry') {
      native.ignoreSetter()
    }
    if (failure === 'geometry') {
      native.setRaw('LANDSCAPE_LEFT')
    }
    const call = (op: string, args?: Record<string, unknown>) => {
      if (op === 'apps' && failure === 'ambiguous') {
        return Promise.resolve([
          ...fixture.apps,
          { bundle_id: 'com.apple.mobilesafari', process_id: 50_813 },
        ])
      }
      if (op === 'ax' && failure === 'PID') {
        const ax = structuredClone(native.ax)
        const application = ax.elements[0]
        if (!application) {
          throw new Error('Recorded application fixture missing')
        }
        application.pid = 900
        return Promise.resolve(ax)
      }
      if (op === 'apps' && failure === 'PID') {
        return Promise.resolve([{ bundle_id: 'com.apple.mobilesafari', process_id: 900 }])
      }
      return native.call(op, args)
    }
    await expect(
      prepareOrientation({
        native: { call },
        udid: QA_DEVICE,
        ready: fixture,
        target: 'LANDSCAPE_LEFT',
        milliseconds: 80,
        screenshot: () => Promise.resolve(),
        capture: () => Promise.resolve(),
        observe,
      }),
    ).rejects.toThrow(
      { ambiguous: 'identity', PID: 'PID changed', UNKNOWN: 'deadline', geometry: 'deadline' }[
        failure
      ],
    )
  }
})

it('restores the actual initial display while reporting that original raw UNKNOWN was not restored', async () => {
  const native = nativeFixture()
  const value = { ...initial(), commandAttempted: true }
  await native.call('orientation', { value: 'LANDSCAPE_LEFT' })
  const restored = await restoreDisplay(native, value, { milliseconds: 1000, maxRpcMs: 500 })
  expect(restored.displayRestored).toBe(true)
  expect(restored.restored.signature).toBe(displaySignature(value.screen))
  expect(restored.rawOrientationRestored).toBe(false)
  expect(restored.initial.rawOrientation).toBe('UNKNOWN')
  expect(restored.restored.rawOrientation).toBe('PORTRAIT')
  expect(restored.contract).toBe('native-display')
  expect(native.calls.filter((op) => op === 'orientation')).toHaveLength(2)
  const wrong = nativeFixture()
  wrong.ax.screen.display.unique_id = 'foreign display'
  await expect(restoreDisplay(wrong, value, { milliseconds: 80, maxRpcMs: 80 })).rejects.toThrow(
    'deadline',
  )
  await expect(
    restoreDisplay(native, initial(), { milliseconds: 80, maxRpcMs: 80 }),
  ).rejects.toThrow('No native orientation command')
})

it('retains exact display-change pending observations at the unchanged settle deadline', async () => {
  const native = nativeFixture()
  const rows: Record<string, unknown>[] = []
  const call = (op: string, args?: Record<string, unknown>) =>
    op === 'ax' ? Promise.reject(new Error(changed)) : native.call(op, args)
  await expect(
    prepareOrientation({
      native: { call },
      udid: QA_DEVICE,
      ready: fixture,
      target: 'PORTRAIT',
      milliseconds: 80,
      screenshot: () => Promise.resolve(),
      capture: () => Promise.resolve(),
      observe: (row) => {
        rows.push(row)
      },
    }),
  ).rejects.toThrow('deadline')
  expect(
    rows.some((row) => row.pendingDisplayChange === true && row.axError === `Error: ${changed}`),
  ).toBe(true)
  expect(native.calls).toContain('apps')
  expect(native.calls.filter((op) => op === 'orientation')).toHaveLength(1)
})
