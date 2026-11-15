/**
 * Measure front/back footstep cues and the audio-thread cost of six native positional voices.
 * Uses public SoundInstance3d.panner and standard Web Audio; no renderer internals.
 *
 * OW_ORIGIN=http://127.0.0.1:4400 bun tools/audio/footstep-spatial.ts
 *
 * The isolated audio graph does not establish a mobile budget: repeat the full game on target
 * devices before accepting its performance. CDP renderCapacity values are reported unchanged.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import type { SoundInstance3d, SoundManager } from 'playcanvas'
import { chromium } from 'playwright'

interface Probe {
  manager: SoundManager
  voices: SoundInstance3d[]
  set: (model: PanningModelType, count: number) => void
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4400'
const evidence = process.env.OW_EVIDENCE ?? '/tmp/out-west-footstep-spatial'
const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--autoplay-policy=no-user-gesture-required'],
})
try {
  const page = await browser.newPage()
  const cdp = await page.context().newCDPSession(page)
  let contextId = ''
  cdp.on('WebAudio.contextCreated', ({ context }) => {
    if (context.contextType === 'realtime') {
      contextId = context.contextId
    }
  })
  await cdp.send('WebAudio.enable')
  await page.route('**/__audio_probe', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Native spatial audio probe</title>',
    }),
  )
  await page.goto(`${origin}/__audio_probe`)
  const cues = await page.evaluate(async () => {
    const modulePath = '/node_modules/playcanvas/build/playcanvas.mjs'
    const pc = (await import(modulePath)) as typeof import('playcanvas')
    const manager = new pc.SoundManager()
    const ctx = manager.context
    if (!ctx) {
      throw new Error('Native audio context unavailable')
    }
    await ctx.resume()
    const buffer = await ctx.decodeAudioData(
      await (await fetch('/experiments/out-west/3d/sfx/steps_cowboy_boards.m4a')).arrayBuffer(),
    )
    const energy = (x: Float32Array) => x.reduce((sum, value) => sum + value * value, 0)
    const earDb = (left: Float32Array, right: Float32Array) =>
      10 * Math.log10(Math.max(1e-24, energy(left)) / Math.max(1e-24, energy(right)))
    const results: Record<
      string,
      { frontBackDifference: number; leftEarDb: number; rightEarDb: number }
    > = {}
    for (const model of ['equalpower', 'HRTF'] as const) {
      const renders: [Float32Array, Float32Array][] = []
      for (const [x, y, z] of [
        [0, 0, -3],
        [0, 0, 3],
        [-3, 0, 0],
        [3, 0, 0],
      ]) {
        const offline = new OfflineAudioContext(2, 48_000, 48_000)
        const source = offline.createBufferSource()
        source.buffer = buffer
        const pan = offline.createPanner()
        pan.panningModel = model
        pan.distanceModel = 'inverse'
        pan.refDistance = 3
        pan.positionX.value = x ?? 0
        pan.positionY.value = y ?? 0
        pan.positionZ.value = z ?? 0
        source.connect(pan).connect(offline.destination)
        source.start(0, 0, 0.34)
        const rendered = await offline.startRendering()
        renders.push([rendered.getChannelData(0), rendered.getChannelData(1)])
      }
      const [front, back, left, right] = renders
      if (!(front && back && left && right)) {
        throw new Error('Missing directional render')
      }
      results[model] = {
        frontBackDifference:
          energy(front[0].map((value, i) => value - (back[0][i] ?? 0))) / energy(front[0]),
        leftEarDb: earDb(...left),
        rightEarDb: earDb(...right),
      }
    }
    const voices = Array.from(
      { length: 6 },
      (_, i) =>
        new pc.SoundInstance3d(manager, new pc.Sound(buffer), {
          position: new pc.Vec3(((i % 3) - 1) * 3, 0, i % 2 ? 3 : -3),
          loop: true,
          volume: 0.3,
          refDistance: 3,
          distanceModel: 'inverse',
        }),
    )
    const nativeDefault = voices[0]?.panner.panningModel
    Reflect.set(globalThis, '__spatialProbe', {
      manager,
      voices,
      set(model, count) {
        voices.forEach((voice, i) => {
          voice.stop()
          voice.panner.panningModel = model
          if (i < count) {
            voice.play()
          }
        })
      },
    } satisfies Probe)
    return { nativeDefault, results }
  })
  check(cues.nativeDefault === 'equalpower', 'Native panning default changed')
  check(
    (cues.results.equalpower?.frontBackDifference ?? 1) < 1e-12,
    'Equalpower front/back control differs',
  )
  check((cues.results.HRTF?.frontBackDifference ?? 0) > 0.05, 'HRTF front/back cue missing')
  check((cues.results.HRTF?.leftEarDb ?? 0) > 1, 'HRTF left cue missing')
  check((cues.results.HRTF?.rightEarDb ?? 0) < -1, 'HRTF right cue missing')
  const cost: { voices: number; model: PanningModelType; mean: number; max: number }[] = []
  for (const count of [0, 3, 6]) {
    for (const model of ['equalpower', 'HRTF'] as const) {
      await page.evaluate(
        ({ model: selected, count: voices }) => {
          ;(Reflect.get(globalThis, '__spatialProbe') as Probe).set(selected, voices)
        },
        { model, count },
      )
      await Bun.sleep(1000)
      const capacities: number[] = []
      for (let i = 0; i < 6; i++) {
        await Bun.sleep(350)
        capacities.push(
          (await cdp.send('WebAudio.getRealtimeData', { contextId })).realtimeData.renderCapacity,
        )
      }
      cost.push({
        voices: count,
        model,
        mean: capacities.reduce((sum, value) => sum + value, 0) / capacities.length,
        max: Math.max(...capacities),
      })
    }
  }
  await page.evaluate(() => {
    const probe = Reflect.get(globalThis, '__spatialProbe') as Probe
    for (const voice of probe.voices) {
      voice.stop()
    }
    probe.manager.destroy()
  })
  const report = { browser: browser.version(), cues, cost }
  await mkdir(evidence, { recursive: true })
  await writeFile(`${evidence}/native.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}
