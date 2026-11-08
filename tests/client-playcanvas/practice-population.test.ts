import { beforeAll, expect, test as it } from 'bun:test'
import { file } from 'bun'
import { createLocalFrontierSession } from '../../src/experiments/out-west/client/frontier-session.ts'
import { practiceBots } from '../../src/experiments/out-west/ffa/client/practice.ts'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'

beforeAll(async () => {
  await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})

it('ordinary practice defaults to four bots and production requests cannot exceed four', () => {
  expect(practiceBots()).toBe(4)
  expect(practiceBots(undefined, false)).toBe(4)
  expect(practiceBots(31, false)).toBe(4)
  expect(practiceBots(3, false)).toBe(3)
  expect(practiceBots(0, false)).toBe(0)
})

it('only explicitly enabled development stress can add31bots beside one human', () => {
  expect(practiceBots(undefined, true)).toBe(4)
  expect(practiceBots(31, true)).toBe(31)
  expect(practiceBots(100, true)).toBe(31)
  expect(practiceBots(-1, true)).toBe(0)
  expect(practiceBots(3.9, true)).toBe(3)
  expect(practiceBots(Number.NaN, true)).toBe(0)
})

it('ordinary native guest sessions are local and contain one human with four bots', async () => {
  const session = await createLocalFrontierSession({
    version: 'practice-population',
    boxes: [{ center: [72, -0.5, 72], halfExtents: [100, 0.5, 100] }],
    meshes: [],
  })
  try {
    expect(session.practice).toBe(true)
    expect(session.lobbyId).toBe('loopback')
    expect(session.world.players.filter((player) => player?.bot)).toHaveLength(4)
    expect(session.world.players.filter((player) => player && !player.bot)).toHaveLength(1)
    expect(session.players.size).toBe(5)
  } finally {
    session.dispose()
  }
})
