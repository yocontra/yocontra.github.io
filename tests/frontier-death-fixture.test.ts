import { expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_AHEAD_FRAMES } from '../src/experiments/out-west/ffa/sim/input.ts'
import {
  type FallTrace,
  fallCoherent,
  renderedUntil,
} from '../tools/character-quality/death-server.ts'
import { clearMotionOutput } from '../tools/character-quality/motion-output.ts'

function falling(): FallTrace {
  return {
    at: 1000,
    tick: 30,
    wireTick: 30,
    pending: 2,
    inputLead: 2,
    authority: { x: 72, y: 9.6, z: 69, vy: -13.5, grounded: false },
    wire: { x: 72, y: 9.6, z: 69, vy: -13.5 },
    predicted: { x: 72, y: 8.2, z: 69, vy: -15.3, grounded: false },
    rendered: { x: 72, y: 8.4, z: 69 },
    source: { feetY: 8.4, rootY: 8.4, vy: -15.3, near: true },
  }
}
it('accepts natural prediction lead while requiring the actual rendered capture source', () => {
  const state = falling()
  expect(fallCoherent(state, -12.7)).toBe(true)
  if (!state.source) {
    throw new Error('Missing source')
  }
  state.source.near = false
  expect(fallCoherent(state, -12.7)).toBe(true)
  expect(state.authority.y).toBe(9.6)
  expect(state.predicted.vy).toBe(-15.3)
})
it('captures the already coherent roof fall before waiting away its first rendered pose', async () => {
  const state = falling()
  state.pending = 4
  state.inputLead = 4
  state.authority.y = 7.231_111_111_111_111
  state.authority.vy = -2.7
  state.wire.y = 7.23
  state.wire.vy = -2.7
  state.predicted.y = 6.242_222_222_222_222
  state.predicted.vy = -6.3
  state.rendered.y = 6.252_360_836_083_611
  state.source = {
    feetY: state.rendered.y,
    rootY: state.rendered.y,
    vy: -6.507_879_703_633_066_4,
    near: true,
  }
  let reads = 0
  const captured = await renderedUntil(
    (value) => fallCoherent(value, -2),
    'already-falling',
    () => {
      reads++
      return state
    },
  )
  expect(captured).toBe(state)
  expect(reads).toBe(1)
})
it('accepts the recorded five-input accelerated fall without requiring authority and render at one height', () => {
  const state = falling()
  state.pending = 5
  state.inputLead = 5
  state.authority.y = 9.6
  state.authority.vy = -13.5
  state.wire.y = 9.6
  state.wire.vy = -13.5
  state.predicted.y = 5.55
  state.predicted.vy = -18
  state.rendered.y = 6.195_511_111_111_115
  state.source = {
    feetY: state.rendered.y,
    rootY: state.rendered.y,
    vy: -18.000_000_000_000_018,
    near: true,
  }
  expect(fallCoherent(state, -12.7)).toBe(true)
  state.inputLead = MAX_AHEAD_FRAMES + 1
  expect(fallCoherent(state, -12.7)).toBe(false)
})
it('clears prior generated motion evidence before a failed replacement can leave stale strips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'out-west-motion-'))
  try {
    for (const name of [
      'alive.png',
      'motion.json',
      'motion.webm',
      'filmstrip.png',
      'body-filmstrip.png',
      'video-filmstrip.png',
      'video-filmstrip-source.json',
      'video-filmstrip-provenance.json',
      'frame-1200.png',
      'gear-offhand.png',
      'reference.png',
    ]) {
      writeFileSync(join(dir, name), 'prior output')
    }
    mkdirSync(join(dir, 'video-frames'))
    writeFileSync(join(dir, 'video-frames/frame-001.png'), 'prior extracted frame')
    clearMotionOutput(dir)
    expect(readdirSync(dir)).toEqual(['reference.png'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
it.each([
  'paused-inputs',
  'centimetre-self-y',
  'stale-root',
  'upward-source',
  'unsettled-prediction',
])('rejects the invalid %s capture setup without changing production state', (kind) => {
  const state = falling()
  if (!state.source) {
    throw new Error('Missing source')
  }
  if (kind === 'paused-inputs') {
    state.pending = 30
  }
  if (kind === 'centimetre-self-y') {
    state.wire.y = 960
  }
  if (kind === 'stale-root') {
    state.source.rootY = 0
  }
  if (kind === 'upward-source') {
    state.source.vy = 12
  }
  if (kind === 'unsettled-prediction') {
    state.rendered.y = 4.1
    state.source.feetY = 4.1
    state.source.rootY = 4.1
  }
  const before = structuredClone(state)
  expect(fallCoherent(state, -12.7)).toBe(false)
  expect(state).toEqual(before)
})
