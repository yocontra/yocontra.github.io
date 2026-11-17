/** Pure native-coordinate tape and evidence joins. No simulator effects on import. */
import type { Frame, PageState } from './simulator-native.ts'
import { nativeSafari } from './simulator-native.ts'
export interface Gesture {
  id: number
  kind: 'tap' | 'swipe'
  at: number
  duration: number
  start: { x: number; y: number }
  end: { x: number; y: number }
  role: string
}
export interface Clock {
  at: number
  wall: number
}
export function nativeTransform(web: Frame, page: PageState, orientation: string) {
  const scale = web.width / page.width
  if (
    !(
      scale > 0 &&
      page.canvas &&
      Math.abs(web.height - page.height * scale) < 4 &&
      ['portrait', 'landscape'].includes(orientation) &&
      (orientation === 'landscape' ? page.width > page.height : page.height > page.width)
    )
  ) {
    throw new Error('Native orientation/CSS/AX transform unproved')
  }
  return {
    scale,
    point: (x: number, y: number) => {
      if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x > page.width || y > page.height) {
        throw new Error('Point outside actual CSS viewport')
      }
      return { x: Math.round(web.x + x * scale), y: Math.round(web.y + y * scale) }
    },
    css: (p: { x: number; y: number }) => ({ x: (p.x - web.x) / scale, y: (p.y - web.y) / scale }),
  }
}
export function gestureTape({
  page,
  web,
  buttons,
  clock,
  orientation,
}: {
  page: PageState
  web: Frame
  buttons: Record<string, Frame>
  clock: Clock
  orientation: string
}): Gesture[] {
  if (![clock.at, clock.wall].every(Number.isFinite)) {
    throw new Error('Actual guest recording clock missing')
  }
  const transform = nativeTransform(web, page, orientation)
  const canvas = page.canvas
  if (!canvas) {
    throw new Error('Actual canvas missing')
  }
  const button = (name: string) => {
    const b = buttons[name]
    if (!b) {
      throw new Error(`Native AX button missing: ${name}`)
    }
    const point = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
    const css = transform.css(point)
    transform.point(css.x, css.y)
    return point
  }
  const tape: Gesture[] = []
  const add = (gesture: Omit<Gesture, 'id' | 'at'> & { offset: number }) => {
    const { offset, ...value } = gesture
    tape.push({ ...value, id: tape.length, at: clock.at + 1500 + offset })
  }
  for (let cycle = 0; cycle < 9; cycle++) {
    const offset = cycle * 6000
    add({
      kind: 'swipe',
      offset,
      duration: 1200,
      start: transform.point(canvas.x + canvas.width * 0.22, canvas.y + canvas.height * 0.7),
      end: transform.point(canvas.x + canvas.width * 0.22, canvas.y + canvas.height * 0.48),
      role: 'move',
    })
    add({
      kind: 'swipe',
      offset: offset + 1600,
      duration: 500,
      start: transform.point(canvas.x + canvas.width * 0.78, canvas.y + canvas.height * 0.44),
      end: transform.point(canvas.x + canvas.width * 0.68, canvas.y + canvas.height * 0.44),
      role: 'look',
    })
    for (const [name, delta, hold] of [
      ['FIRE', 2400, 150],
      ['AIM', 3000, 400],
      ['FIRE', 3800, 150],
      ['RELOAD', 4500, 150],
    ] as const) {
      const p = button(name)
      add({ kind: 'tap', offset: offset + delta, duration: hold, start: p, end: p, role: name })
    }
  }
  return tape
}
export interface TrustedInput {
  at: number
  type: string
  x?: number
  y?: number
  pointerId?: number
}
/** Match every planned endpoint once, preserving all raw events and any missing/late endpoints. */
export function joinGestures(
  tape: readonly Gesture[],
  inputs: readonly TrustedInput[],
  web: Frame,
  page: PageState,
) {
  const scale = web.width / page.width
  const used = new Set<number>()
  const ends: {
    id: number
    edge: string
    expected: number
    observed: number | null
    errorMs: number | null
    index: number | null
  }[] = []
  for (const g of tape) {
    let down: TrustedInput | undefined
    for (const [edge, type, p, expected] of [
      ['down', 'pointerdown', g.start, g.at],
      ['up', 'pointerup', g.end, g.at + g.duration],
    ] as const) {
      const x = (p.x - web.x) / scale
      const y = (p.y - web.y) / scale
      const pointer = down?.pointerId
      const hasDown = Boolean(down)
      const candidates = inputs
        .map((e, index) => ({ e, index }))
        .filter(
          ({ e, index }) =>
            !used.has(index) &&
            e.type === type &&
            Math.hypot(
              (e.x ?? Number.POSITIVE_INFINITY) - x,
              (e.y ?? Number.POSITIVE_INFINITY) - y,
            ) <= 5 &&
            (!hasDown || e.pointerId === pointer) &&
            e.at >= g.at - 1000 &&
            e.at <= g.at + g.duration + 1000,
        )
      candidates.sort((a, b) => Math.abs(a.e.at - expected) - Math.abs(b.e.at - expected))
      const found = candidates[0]
      if (found) {
        used.add(found.index)
        if (edge === 'down') {
          down = found.e
        }
      }
      ends.push({
        id: g.id,
        edge,
        expected,
        observed: found?.e.at ?? null,
        errorMs: found ? found.e.at - expected : null,
        index: found?.index ?? null,
      })
    }
  }
  const shapes = tape.map((g) => {
    const [a, b] = ends.filter((e) => e.id === g.id)
    const first = a?.index === null ? undefined : inputs[a?.index ?? -1]
    const last = b?.index === null ? undefined : inputs[b?.index ?? -1]
    const moves = inputs.filter(
      (e) =>
        e.type === 'pointermove' &&
        first &&
        last &&
        e.pointerId === first.pointerId &&
        e.at > first.at &&
        e.at < last.at,
    )
    const dx = (g.end.x - g.start.x) / scale
    const dy = (g.end.y - g.start.y) / scale
    const length = Math.hypot(dx, dy)
    const sx = (g.start.x - web.x) / scale
    const sy = (g.start.y - web.y) / scale
    const progress = moves.map((e) =>
      length
        ? (((e.x ?? Number.POSITIVE_INFINITY) - sx) * dx +
            ((e.y ?? Number.POSITIVE_INFINITY) - sy) * dy) /
          length
        : 0,
    )
    const monotonic = progress.every(
      (value, index) =>
        value >= -5 &&
        value <= length + 5 &&
        (index === 0 || value >= (progress[index - 1] ?? 0) - 5),
    )
    const maxCrossTrack = Math.max(
      0,
      ...moves.map((e) =>
        length
          ? Math.abs(
              ((e.x ?? Number.POSITIVE_INFINITY) - sx) * dy -
                ((e.y ?? Number.POSITIVE_INFINITY) - sy) * dx,
            ) / length
          : 0,
      ),
    )
    const durationErrorMs = first && last ? last.at - first.at - g.duration : null
    return {
      id: g.id,
      moves: moves.length,
      maxCrossTrack,
      durationErrorMs,
      passed:
        durationErrorMs !== null &&
        Math.abs(durationErrorMs) <= 35 &&
        (g.kind !== 'swipe' || (moves.length > 0 && maxCrossTrack <= 5 && monotonic)),
    }
  })
  return {
    toleranceMs: 35,
    endpoints: ends,
    shapes,
    rawInputCount: inputs.length,
    unmatchedInputIndices: inputs.map((_, i) => i).filter((i) => !used.has(i)),
    passed:
      ends.length > 0 &&
      ends.every((e) => e.errorMs !== null && Math.abs(e.errorMs) <= 35) &&
      shapes.every((s) => s.passed),
  }
}
export function nativeForeground(
  samples: readonly { wall: number; ax: unknown; orientation: string }[],
  expected: { start: number; end: number; orientation: string },
) {
  const identities = samples.map((s) => nativeSafari(s.ax))
  const pid = identities[0]?.pid
  const gaps = samples.slice(1).map((s, i) => s.wall - (samples[i]?.wall ?? 0))
  const maximumGapMs = Math.max(0, ...gaps)
  const startOffsetMs = (samples[0]?.wall ?? Number.POSITIVE_INFINITY) - expected.start
  const endOffsetMs = (samples.at(-1)?.wall ?? Number.NEGATIVE_INFINITY) - expected.end
  return {
    pid: pid ?? null,
    sampleCount: samples.length,
    startOffsetMs,
    endOffsetMs,
    maximumGapMs,
    passed:
      Boolean(pid) &&
      expected.end > expected.start &&
      samples.length >= 2 &&
      samples.every(
        (s, i) =>
          identities[i]?.pid === pid &&
          s.orientation === expected.orientation &&
          (i === 0 || s.wall > (samples[i - 1]?.wall ?? Number.POSITIVE_INFINITY)),
      ) &&
      Math.abs(startOffsetMs) <= 1000 &&
      Math.abs(endOffsetMs) <= 1000 &&
      maximumGapMs <= 1750,
  }
}
export function recordingOptions(population: string, orientation: string) {
  if (
    !(
      ['ordinary', 'stress'].includes(population) && ['portrait', 'landscape'].includes(orientation)
    )
  ) {
    throw new Error('Expected ordinary/stress and portrait/landscape')
  }
  return {
    population: population as 'ordinary' | 'stress',
    orientation: orientation as 'portrait' | 'landscape',
    seconds: 60 as const,
  }
}

/** Count walking only within a continuous living incarnation, never across respawn teleports. */
export function walkingEvidence(
  samples: readonly {
    wall: number
    self?: { x: number; z: number; alive: boolean; deaths: number } | null | undefined
  }[],
) {
  const segments = samples.slice(1).map((sample, index) => {
    const previous = samples[index]
    const a = previous?.self
    const b = sample.self
    const seconds = (sample.wall - (previous?.wall ?? sample.wall)) / 1000
    const distance = a && b ? Math.hypot(b.x - a.x, b.z - a.z) : 0
    const continuous = Boolean(
      a?.alive && b?.alive && a.deaths === b.deaths && seconds > 0 && seconds <= 2.5,
    )
    const plausible = distance <= 12 * seconds + 0.1
    let reason = 'death/respawn/missing sample'
    if (continuous) {
      reason = plausible ? 'living movement' : 'displacement exceeds movement envelope'
    }
    return {
      wall: sample.wall,
      distance,
      seconds,
      included: continuous && plausible,
      reason,
    }
  })
  return {
    segments,
    distance: segments.filter((s) => s.included).reduce((sum, s) => sum + s.distance, 0),
  }
}
export function cleanupComplete(cleanup: Record<string, unknown>) {
  const client = cleanup.nativeClient as
    | { exitCode?: number; pipeDrainComplete?: boolean; closeFailure?: string }
    | undefined
  return (
    cleanup.settingsRestored === true &&
    cleanup.orientationRestored === true &&
    cleanup.deviceShutdown === true &&
    cleanup.ownedPidsAbsent === true &&
    cleanup.nativePortFree === true &&
    client?.exitCode === 0 &&
    client.pipeDrainComplete === true &&
    !client.closeFailure &&
    !cleanup.nativeClientFailure &&
    !cleanup.companionCleanupFailure &&
    !cleanup.nativeTerminationFailure
  )
}
export function finalRecordingVerdict(
  issues: readonly string[],
  target: { passed: boolean } | null,
  cleanup: Record<string, unknown>,
) {
  if (issues.length > 0 || !cleanupComplete(cleanup)) {
    return { qualification: 'incomplete', performanceTarget: 'unqualified' }
  }
  return { qualification: 'complete', performanceTarget: target?.passed ? 'pass' : 'fail' }
}

export function recordingMode(args: readonly string[]) {
  const preflight = args.includes('--preflight')
  const record = args.includes('--record')
  if (preflight === record) {
    throw new Error('Choose exactly one --preflight (2s) or --record (60s)')
  }
  if (args.some((value) => value.startsWith('--seconds='))) {
    throw new Error('Durations are fixed: preflight2s/record60s')
  }
  return preflight ? 'preflight' : 'record'
}
