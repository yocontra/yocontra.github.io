import { expect, test as it } from 'bun:test'
import { NativeArenas } from '../../src/experiments/out-west/duel/native-arenas.ts'

function fixture(dailyDenseFog = false) {
  const requests: (() => void)[] = []
  const clocks: number[] = []
  const scene = { skyboxIntensity: 0.7 }
  const arena = {
    lightingEpoch: 0,
    dailyDenseFog,
    game: { app: { scene } },
    night: () => undefined,
    environment: {
      poster: () => undefined,
      setTime: () => new Promise<void>((resolve) => requests.push(resolve)),
      clock: (day: number) => clocks.push(day),
    },
  } as unknown as NativeArenas
  return { arena, requests, clocks, scene }
}

it('a late night sky cannot brighten a newer daytime arena', async () => {
  const f = fixture()
  const night = NativeArenas.prototype.lighting.call(f.arena, 1)
  const day = NativeArenas.prototype.lighting.call(f.arena, 0)
  f.requests[1]?.()
  await day
  expect(f.scene.skyboxIntensity).toBe(0.7)
  f.requests[0]?.()
  await night
  expect(f.scene.skyboxIntensity).toBe(0.7)
  expect(f.clocks).toEqual([0])
})

it('night uses the native environment atlas while Daily fog keeps its authored darkness', async () => {
  await Promise.all(
    [false, true].map(async (fog) => {
      const f = fixture(fog)
      const loading = NativeArenas.prototype.lighting.call(f.arena, 1)
      f.requests[0]?.()
      await loading
      expect(f.scene.skyboxIntensity).toBe(fog ? 0.7 : 1.4)
      expect(f.clocks).toEqual([1])
    }),
  )
})
