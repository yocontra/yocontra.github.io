/**
 * Record a real Frontier firefight in Chrome for listening and mix measurement: the local rider
 * strafes and fires in the main street while `bots` riders fight around them. Writes the page's
 * actual output (`<scene>.wav`), the play log, and prints the integrated loudness, true peak, the
 * mix's per-category meters and how many sounds each voice budget let through.
 *
 *   OW_ORIGIN=http://127.0.0.1:4390 bun tools/audio/frontier-firefight.ts <scene> <bots> [seconds] [--cluster] [--stems] [--listen]
 *
 * `--listen` asks Gemini to score the recording for density, masking and readability.
 * `--equalpower` disables optional HRTF through the public play API for a comparison capture.
 * `--spatial-check` first verifies the native six-voice cap and stop/end/disposal reuse.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import type { Entity, SoundComponent, SoundInstance3d } from 'playcanvas'
import { chromium } from 'playwright'
import type {
  FrontierAudio,
  PlayedSound,
} from '../../src/experiments/out-west/client/frontier-audio.ts'
import type { MixCategory } from '../../src/experiments/out-west/client/frontier-mix.ts'
import type { GameViewport } from '../../src/experiments/out-west/client/viewport.ts'
import { footstepMasking } from './footstep-mask.ts'
import { listen } from './vendors.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-frontier-audio'
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'))
/**
 * Recorded alongside the full mix: the footsteps, to measure how often they are masked, and with
 * `--stems` every bus (for offline rebalancing).
 */
const STEMS: MixCategory[] = process.argv.includes('--stems')
  ? ['feet', 'own', 'gun', 'impact', 'tail', 'crack', 'foley', 'amb']
  : ['feet']
const [scene = 'firefight', botsArg = '4', secondsArg = '30'] = argv
const bots = Number(botsArg)
/** `--cluster`: every bot rallies on the listener (the stress case), not a natural lobby. */
const cluster = process.argv.includes('--cluster')
const seconds = Number(secondsArg)
const INTEGRATED = /I:\s+(?<v>-?[\d.]+) LUFS/u
const RANGE = /LRA:\s+(?<v>-?[\d.]+) LU/u
const PEAK = /Peak:\s+(?<v>-?[\d.]+) dBFS/u
await mkdir(output, { recursive: true })

const PROMPT = `You are a strict AAA game audio director reviewing a ${seconds}-second capture of a dense multiplayer western shooter firefight (${bots} AI players on foot${cluster ? ' all closing on the listener' : ' roaming the town'}, the listener strafes and fires a revolver). Target: Call of Duty Mobile competitive readability with Red Dead Redemption 2 grounded western sound. Judge: (1) masking: can you tell the listener's own gun from enemy fire, and hear bullet impacts, hit markers and nearby enemy FOOTSTEPS through the gunfire? (2) density: does the fight stay clear and punchy or collapse into a wall of sound? (3) dynamics: pumping, clipping, harshness, spikes. (4) repetition: are any sounds obviously looped/identical? (5) ambience: does the town bed survive between bursts? Describe only audible content; do not infer a sound source or processing artifact solely from the genre or density. Reply with JSON only: {"heard": string (timestamped notable events), "masking": 1-10, "density": 1-10, "dynamics": 1-10, "repetition": 1-10, "footstepsReadable": boolean, "ownGunDistinct": boolean, "overall": 1-10, "problems": string}`

/** Tee everything that reaches the speakers into a recorder, before the game makes its context. */
const TAP = `(() => {
  const connect = AudioNode.prototype.connect
  const disconnect = AudioNode.prototype.disconnect
  AudioNode.prototype.disconnect = function (...args) {
    const ctx = this.context
    if ((args.length === 0 || args[0] instanceof AudioDestinationNode) && ctx.__tap && this.__tapped) {
      this.__tapped = false
      disconnect.call(this, ctx.__tap)
    }
    return args.length === 0 ? disconnect.call(this) : disconnect.apply(this, args)
  }
  AudioNode.prototype.connect = function (destination, ...rest) {
    const result = connect.call(this, destination, ...rest)
    if (destination instanceof AudioDestinationNode) {
      const ctx = destination.context
      ctx.__tap ??= ctx.createMediaStreamDestination()
      globalThis.__tap = ctx.__tap
      if (!this.__tapped) {
        this.__tapped = true
        connect.call(this, ctx.__tap)
      }
    }
    return result
  }
  const record = (stream) => {
    const chunks = []
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 256000 })
    rec.ondataavailable = (e) => chunks.push(e.data)
    rec.start(250)
    return () => new Promise((done) => {
      rec.onstop = async () => {
        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
        let s = ''
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        done(btoa(s))
      }
      rec.stop()
    })
  }
  globalThis.__startRecording = (stems) => {
    globalThis.__stopRecording = record(globalThis.__tap.stream)
    globalThis.__stopStems = stems.map((node) => {
      const dest = node.context.createMediaStreamDestination()
      connect.call(node, dest)
      return record(dest.stream)
    })
  }
})()`

const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const cdp = await page.context().newCDPSession(page)
const contextIds = new Set<string>()
const capacity: number[] = []
cdp.on('WebAudio.contextCreated', ({ context }) => {
  if (context.contextType === 'realtime') {
    contextIds.add(context.contextId)
  }
})
cdp.on('WebAudio.contextWillBeDestroyed', ({ contextId }) => contextIds.delete(contextId))
await cdp.send('WebAudio.enable')
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.stack ?? e.message))
await page.addInitScript({ content: TAP })
await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
await page.goto(
  `${origin}/experiments/out-west/frontier/?server=loopback&bots=${bots}${cluster ? '&cluster' : ''}&seed=7&spawn=72,66`,
  { waitUntil: 'domcontentloaded' },
)
await page.waitForFunction(
  () => Boolean((Reflect.get(globalThis, '__frontierAudio') as FrontierAudio | undefined)?.context),
  undefined,
  { timeout: 90_000 },
)
if (process.argv.includes('--spatial-check')) {
  const proof = await page.evaluate(async () => {
    const audio = Reflect.get(globalThis, '__frontierAudio') as FrontierAudio
    await audio.ready
    const emitter = audio.emitter('spatial-proof')
    const root = emitter.entity.root as Entity
    for (const sound of root.findComponents('sound') as SoundComponent[]) {
      if (sound.entity.name.startsWith('feet-')) {
        sound.stop()
      }
    }
    emitter.entity.setPosition(audio.listener)
    const original = audio.playOn.bind(audio)
    audio.playOn = (source, name, options = {}) =>
      options.binaural && source !== emitter ? null : original(source, name, options)
    const voices: SoundInstance3d[] = []
    const play = (pitch = 0.25) => {
      const voice = audio.playOn(emitter, 'stepWood', {
        binaural: true,
        range: 'step',
        variant: 0,
        pitch,
      }) as SoundInstance3d | null
      if (!voice) {
        throw new Error('Spatial proof could not start a native step')
      }
      voices.push(voice)
      return voice
    }
    try {
      const initial = Array.from({ length: 7 }, () => play().panner.panningModel)
      voices[0]?.stop()
      const afterStop = play().panner.panningModel
      for (const voice of voices) {
        voice.stop()
      }
      const short = play(8)
      await new Promise<void>((resolve) => short.once('end', resolve))
      const afterEnd = Array.from({ length: 6 }, () => play().panner.panningModel)
      for (const voice of voices) {
        voice.stop()
      }
      const modulePath = '/src/experiments/out-west/client/frontier-spatial.ts'
      const { FootstepSpatializer } = (await import(
        modulePath
      )) as typeof import('../../src/experiments/out-west/client/frontier-spatial.ts')
      const spatial = new FootstepSpatializer()
      const disposable = original(emitter, 'stepWood', {
        range: 'step',
        pitch: 0.25,
      }) as SoundInstance3d
      voices.push(disposable)
      const applied = spatial.apply(disposable)
      const repeated = spatial.apply(disposable)
      spatial.destroy()
      const afterDispose = {
        applied,
        repeated,
        model: disposable.panner.panningModel,
        accepted: spatial.apply(disposable),
      }
      return { initial, afterStop, afterEnd, afterDispose }
    } finally {
      for (const voice of voices) {
        voice.stop()
      }
      emitter.entity.destroy()
      audio.playOn = original
    }
  })
  const valid =
    proof.initial.slice(0, 6).every((model) => model === 'HRTF') &&
    proof.initial[6] === 'equalpower' &&
    proof.afterStop === 'HRTF' &&
    proof.afterEnd.every((model) => model === 'HRTF') &&
    proof.afterDispose.applied &&
    proof.afterDispose.repeated &&
    proof.afterDispose.model === 'equalpower' &&
    !proof.afterDispose.accepted
  console.log(`  native spatial lifecycle ${JSON.stringify(proof)}`)
  if (!valid) {
    await browser.close()
    throw new Error('Native footstep spatial lifecycle failed')
  }
}
if (process.argv.includes('--equalpower')) {
  await page.evaluate(() => {
    const audio = Reflect.get(globalThis, '__frontierAudio') as FrontierAudio
    const original = audio.playOn.bind(audio)
    audio.playOn = (source, name, options = {}) =>
      original(source, name, { ...options, binaural: false })
  })
}
await Bun.sleep(2500)
const t0 = await page.evaluate((stemNames) => {
  const audio = Reflect.get(globalThis, '__frontierAudio') as FrontierAudio
  const frames: number[] = []
  Reflect.set(globalThis, '__audioProbeFrames', frames)
  const frame = (time: number) => {
    frames.push(time)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  const nodes = stemNames.map((c) => audio.stem(c as MixCategory))
  ;(Reflect.get(globalThis, '__startRecording') as (stems: unknown[]) => void)(nodes)
  return audio.clock
}, STEMS)
const end = Date.now() + seconds * 1000
let side = 'KeyA'
let n = 0
while (Date.now() < end) {
  await page.keyboard.down(side)
  for (let i = 0; i < 3 && Date.now() < end; i++) {
    if ((n + i) % 4 !== 3) {
      await page.evaluate(() =>
        (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport | undefined)?.tap(1),
      )
    }
    await Bun.sleep(450 + Math.random() * 300)
  }
  await page.keyboard.up(side)
  side = side === 'KeyA' ? 'KeyD' : 'KeyA'
  if (++n % 5 === 0) {
    await page.keyboard.press('KeyR')
    await Bun.sleep(900)
  }
  for (const contextId of contextIds) {
    const data = await cdp.send('WebAudio.getRealtimeData', { contextId })
    capacity.push(data.realtimeData.renderCapacity)
  }
}
const frameStats = await page.evaluate(() => {
  const frames = Reflect.get(globalThis, '__audioProbeFrames') as number[]
  const intervals = frames
    .slice(1)
    .map((time, i) => time - (frames[i] ?? time))
    .sort((a, b) => a - b)
  return {
    fps: ((frames.length - 1) * 1000) / ((frames.at(-1) ?? 0) - (frames[0] ?? 0)),
    p95FrameMs: intervals[Math.floor(intervals.length * 0.95)],
  }
})
const played = await page.evaluate(
  (t) =>
    ((Reflect.get(globalThis, '__frontierAudio') as FrontierAudio).log as PlayedSound[]).filter(
      (e) => e.t >= t,
    ),
  t0,
)
const stats = await page.evaluate(() => {
  const audio = Reflect.get(globalThis, '__frontierAudio') as FrontierAudio & {
    mixStats?: () => unknown
  }
  return audio.mixStats?.() ?? null
})
const audio = await page.evaluate(() =>
  (Reflect.get(globalThis, '__stopRecording') as () => Promise<string>)(),
)
const stems = await page.evaluate(() =>
  Promise.all(
    (Reflect.get(globalThis, '__stopStems') as (() => Promise<string>)[]).map((f) => f()),
  ),
)
await browser.close()

const webm = `${output}/${scene}.webm`
const wav = `${output}/${scene}.wav`
await writeFile(webm, Buffer.from(audio, 'base64'))
await writeFile(`${output}/${scene}.log.json`, JSON.stringify(played, null, 1))
await Bun.$`ffmpeg -y -loglevel error -i ${webm} -ar 48000 ${wav}`
for (const [i, name] of STEMS.entries()) {
  const stemWebm = `${output}/${scene}.${name}.webm`
  await writeFile(stemWebm, Buffer.from(stems[i] ?? '', 'base64'))
  await Bun.$`ffmpeg -y -loglevel error -i ${stemWebm} -ar 48000 ${output}/${scene}.${name}.wav`
}

const meter = (
  await Bun.$`ffmpeg -hide_banner -nostats -i ${wav} -af ebur128=peak=true -f null -`
    .nothrow()
    .quiet()
).stderr.toString()
const summary = meter.slice(meter.lastIndexOf('Summary:'))
const integrated = INTEGRATED.exec(summary)?.groups?.v
const range = RANGE.exec(summary)?.groups?.v
const peak = PEAK.exec(summary)?.groups?.v
const counts: Record<string, number> = {}
for (const e of played) {
  counts[e.name] = (counts[e.name] ?? 0) + 1
}
console.log(`${scene}: ${bots} bots, ${seconds} s, ${played.length} plays`)
console.log(`  integrated ${integrated} LUFS, LRA ${range} LU, true peak ${peak} dBFS`)
console.log(
  `  performance ${JSON.stringify({ ...frameStats, renderCapacityMean: capacity.reduce((sum, value) => sum + value, 0) / capacity.length, renderCapacityMax: Math.max(...capacity) })}`,
)
console.log(`  plays ${JSON.stringify(counts)}`)
if (stats) {
  console.log(`  mix ${JSON.stringify(stats)}`)
}
const masking = await footstepMasking(wav, `${output}/${scene}.feet.wav`)
console.log(`  footsteps (onsets, % audible, median step-to-rest dB) ${JSON.stringify(masking)}`)
if (errors.length > 0) {
  console.log(`  page errors: ${errors.slice(0, 3).join(' | ')}`)
}
if (process.argv.includes('--listen')) {
  // One listen is noisy (±2 between identical runs): three, and the median overall is the score.
  const once = () => listen(wav, PROMPT)
  const verdicts: string[] = []
  for (let i = 0; i < 3; i++) {
    verdicts.push(
      await once()
        .catch(once)
        .catch((e: unknown) => `error: ${String(e).slice(0, 200)}`),
    )
  }
  const overall = verdicts
    .map((v) => Number((JSON.parse(v.startsWith('{') ? v : '{}') as { overall?: number }).overall))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  await writeFile(`${output}/${scene}.listen.txt`, verdicts.join('\n\n'))
  for (const v of verdicts) {
    console.log(`  listen ${v.replaceAll(/\s+/gu, ' ')}`)
  }
  console.log(`  overall ${overall.join(', ')} (median ${overall[1] ?? overall[0] ?? '?'})`)
}
