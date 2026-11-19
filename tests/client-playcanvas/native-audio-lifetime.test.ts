import { expect, it, spyOn } from 'bun:test'
import { AppBase, AppOptions, Asset, NullGraphicsDevice, Sound, SoundManager } from 'playcanvas'
import { NativeAudioHandler } from '../../src/experiments/out-west/client/native-audio-handler.ts'

function audioFixture() {
  const contexts: AudioContextProbe[] = []
  const bytes = new ArrayBuffer(16)
  const decodedBuffer = { duration: 1.25 } as AudioBuffer
  const requests: Parameters<typeof Asset.fetchArrayBuffer>[] = []
  const fetch = spyOn(Asset, 'fetchArrayBuffer').mockImplementation((...args) => {
    requests.push(args)
  })
  class AudioContextProbe {
    state: AudioContextState = 'running'
    readonly decoded: ArrayBuffer[] = []

    constructor() {
      contexts.push(this)
    }

    close(): Promise<void> {
      this.state = 'closed'
      return Promise.resolve()
    }

    decodeAudioData(encoded: ArrayBuffer, success: DecodeSuccessCallback): Promise<AudioBuffer> {
      this.decoded.push(encoded)
      success(decodedBuffer)
      return Promise.resolve(decodedBuffer)
    }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: AudioContextProbe,
  })
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const options = new AppOptions()
  options.graphicsDevice = device
  options.soundManager = new SoundManager()
  options.resourceHandlers = [NativeAudioHandler]
  app.init(options)
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  if (!priorWindow) {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  }
  const handler = app.loader.getHandler('audio')
  if (!handler) {
    throw new Error('Missing native audio handler')
  }
  app.loader.enableRetry(3)
  let closed = false
  function close() {
    if (!closed) {
      closed = true
      app.destroy()
    }
  }
  function load() {
    const asset = new Asset('sidearm', 'audio', { url: '/audio/rev_close.m4a' })
    app.assets.add(asset)
    app.assets.load(asset)
    return asset
  }
  return {
    load,
    close,
    handler,
    requests,
    contexts,
    bytes,
    decodedBuffer,
    dispose() {
      close()
      fetch.mockRestore()
      if (!priorWindow) {
        Reflect.deleteProperty(globalThis, 'window')
      }
      if (original) {
        Object.defineProperty(globalThis, 'AudioContext', original)
      } else {
        Reflect.deleteProperty(globalThis, 'AudioContext')
      }
    },
  }
}

it('ignores a delayed native audio response after destroying the application', () => {
  const f = audioFixture()
  try {
    const asset = f.load()
    const request = f.requests[0]
    if (!request) {
      throw new Error('Missing pending native audio fetch')
    }
    const [, complete] = request
    expect(f.contexts).toHaveLength(1)
    f.close()
    expect(f.contexts[0]?.state).toBe('closed')
    complete(null, f.bytes)
    expect(f.contexts).toHaveLength(1)
    expect(f.contexts[0]?.decoded).toEqual([])
    expect(asset.resource).toBeFalsy()

    f.handler.load('/audio/late.m4a', () => undefined)
    expect(f.contexts).toHaveLength(1)
    expect(f.requests).toHaveLength(1)
  } finally {
    f.dispose()
  }
})

it('uses the native fetch retry contract and decodes an audio asset while the application is live', () => {
  const f = audioFixture()
  try {
    const asset = f.load()
    const request = f.requests[0]
    if (!request) {
      throw new Error('Missing pending native audio fetch')
    }
    const [url, complete, owner, retries] = request
    expect(url).toBe('/audio/rev_close.m4a')
    expect(owner).toBe(asset)
    expect(retries).toBe(3)
    complete(null, f.bytes)
    expect(asset.resource).toBeInstanceOf(Sound)
    expect((asset.resource as Sound).buffer).toBe(f.decodedBuffer)
    expect(f.contexts).toHaveLength(1)
    expect(f.contexts[0]?.decoded).toEqual([f.bytes])
    f.close()
    expect(f.contexts[0]?.state).toBe('closed')
  } finally {
    f.dispose()
  }
})
