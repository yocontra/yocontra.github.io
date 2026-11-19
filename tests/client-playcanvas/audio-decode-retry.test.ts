import { afterEach, expect, test as it, mock, spyOn } from 'bun:test'
import { AudioEngine } from '../../src/experiments/out-west/audio/audio.ts'
import { PLAYER_VOICE } from '../../src/experiments/out-west/audio/voices.ts'

const url = '/sample.m4a'
const fetchAPI: { fetch: (url: string) => Promise<Response> } = globalThis
const tone = { length: 100, numberOfChannels: 1 } as AudioBuffer
const data = () => new Response(new Uint8Array([1, 2, 3]))
const methods = (engine: AudioEngine) => ({
  fetchRaw: Reflect.get(engine, 'fetchRaw').bind(engine) as (
    key: string,
  ) => Promise<ArrayBuffer | null>,
  decode: Reflect.get(engine, 'decode').bind(engine) as (
    key: string,
  ) => Promise<AudioBuffer | null>,
})
const setContext = (engine: AudioEngine, decodeAudioData: () => Promise<AudioBuffer>) => {
  const ctx = { state: 'running' as AudioContextState, decodeAudioData }
  engine.ctx = ctx as unknown as AudioContext
  return ctx
}
const clock = () => {
  let now = 100
  spyOn(performance, 'now').mockImplementation(() => now)
  return (ms: number) => {
    now += ms
  }
}

afterEach(() => {
  mock.restore()
})

it('shares the prefetch through decode and backs off a failed fetch without extending the deadline', async () => {
  const advance = clock()
  const stalled = Promise.withResolvers<Response>()
  const fetched = spyOn(fetchAPI, 'fetch')
    .mockImplementationOnce(() => stalled.promise)
    .mockImplementation(async () => data())
  const engine = new AudioEngine()
  const { fetchRaw, decode } = methods(engine)
  expect(await decode(url)).toBeNull()
  expect(fetched).toHaveBeenCalledTimes(0)
  const prefetch = fetchRaw(url)
  expect(fetchRaw(url)).toBe(prefetch)
  stalled.reject(new Error('aborted'))
  expect(await prefetch).toBeNull()

  const pendingBuffer = Promise.withResolvers<AudioBuffer>()
  const ctx = setContext(engine, () => pendingBuffer.promise)
  const decodeCalls = spyOn(ctx, 'decodeAudioData')
  for (let i = 0; i < 120; i++) {
    advance(15)
    // biome-ignore lint/performance/noAwaitInLoops: each simulated frame settles before the next request.
    const missed = await Promise.all([decode(url), fetchRaw(url)])
    expect(missed).toEqual([null, null])
  }
  expect(fetched).toHaveBeenCalledTimes(1)
  expect(decodeCalls).toHaveBeenCalledTimes(0)
  advance(201)
  const recoveredPrefetch = fetchRaw(url)
  const waiting = decode(url)
  expect(decode(url)).toBe(waiting)
  await recoveredPrefetch
  expect(fetchRaw(url)).toBe(recoveredPrefetch)
  pendingBuffer.resolve(tone)
  expect(await waiting).toBe(tone)
  expect(decode(url)).toBe(waiting)
  expect(await fetchRaw(url)).toBeNull()
  expect(fetched).toHaveBeenCalledTimes(2)
  expect(decodeCalls).toHaveBeenCalledTimes(1)
  expect(engine.stats().buffers).toBe(1)
  expect(Reflect.get(engine, 'raw').size).toBe(0)
})

it('re-fetches after decode failure through the public voice loader and retains successful decode', async () => {
  const advance = clock()
  const fetcher = spyOn(fetchAPI, 'fetch').mockImplementation(async () => data())
  const engine = new AudioEngine()
  const ctx = setContext(engine, async () => tone)
  const decoder = spyOn(ctx, 'decodeAudioData').mockImplementationOnce(() =>
    Promise.reject(new Error('could not decode')),
  )
  const { decode } = methods(engine)
  engine.loadVoice('not a roster entry')
  expect(await decode(PLAYER_VOICE.url)).toBeNull()
  engine.loadVoice('not a roster entry')
  expect(await decode(PLAYER_VOICE.url)).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(1)
  advance(2000)
  engine.loadVoice('not a roster entry')
  expect(await decode(PLAYER_VOICE.url)).toBe(tone)
  engine.loadVoice('not a roster entry')
  expect(await decode(PLAYER_VOICE.url)).toBe(tone)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(decoder).toHaveBeenCalledTimes(2)
  expect(engine.stats().buffers).toBe(1)
})

it('discards a late decode when its context closes and releases the pending raw data', async () => {
  clock()
  const fetched = spyOn(fetchAPI, 'fetch').mockImplementation(async () => data())
  const buffer = Promise.withResolvers<AudioBuffer>()
  const decodeStarted = Promise.withResolvers<void>()
  const engine = new AudioEngine()
  const ctx = setContext(engine, () => {
    decodeStarted.resolve()
    return buffer.promise
  })
  const { decode } = methods(engine)
  const pending = decode(url)
  await decodeStarted.promise
  ctx.state = 'closed'
  buffer.resolve(tone)
  expect(await pending).toBeNull()
  expect(await decode(url)).toBeNull()
  expect(engine.stats().buffers).toBe(0)
  expect(Reflect.get(engine, 'raw').size).toBe(0)
  expect(Reflect.get(engine, 'decoding').size).toBe(0)
  expect(fetched).toHaveBeenCalledTimes(1)
})
