/**
 * Record a real Frontier firefight in Chrome for listening and mix measurement: the local rider
 * strafes and fires in the main street while `bots` riders fight around them. Writes the page's
 * actual output (`<scene>.wav`), the play log, and prints the integrated loudness, true peak, the
 * mix's per-category meters and how many sounds each voice budget let through.
 *
 *   OW_ORIGIN=http://127.0.0.1:4390 bun tools/audio/frontier-firefight.ts <scene> <bots> [seconds] [--cluster] [--stems] [--listen]
 *
 * `--listen` asks Gemini to score the recording for density, masking and readability.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import type {
  FrontierAudio,
  PlayedSound,
} from '../../src/experiments/out-west/client/frontier-audio.ts'
import type { MixCategory } from '../../src/experiments/out-west/client/frontier-mix.ts'
import type { GameViewport } from '../../src/experiments/out-west/client/viewport.ts'
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

const PROMPT = `You are a strict AAA game audio director reviewing a ${seconds}-second capture of a dense multiplayer western shooter firefight (${bots} AI riders${cluster ? ' all closing on the listener' : ' roaming the town'}, the listener strafes and fires a revolver). Target: Call of Duty Mobile competitive readability with Red Dead Redemption 2 grounded western sound. Judge: (1) masking: can you tell the listener's own gun from enemy fire, and hear bullet impacts, hit markers and nearby enemy FOOTSTEPS through the gunfire? (2) density: does the fight stay clear and punchy or collapse into a wall of sound? (3) dynamics: pumping, clipping, harshness, spikes. (4) repetition: are any sounds obviously looped/identical? (5) ambience: does the town bed survive between bursts? Reply with JSON only: {"heard": string (timestamped notable events), "masking": 1-10, "density": 1-10, "dynamics": 1-10, "repetition": 1-10, "footstepsReadable": boolean, "ownGunDistinct": boolean, "overall": 1-10, "problems": string}`

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
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
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
await Bun.sleep(2500)
const t0 = await page.evaluate((stemNames) => {
  const audio = Reflect.get(globalThis, '__frontierAudio') as FrontierAudio
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
}
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

/** 5 ms band powers (1.5–6 kHz, where a heel's click is heard) of a recording. */
async function bandFrames(file: string, gainDb = 0): Promise<number[]> {
  const raw =
    await Bun.$`ffmpeg -loglevel error -i ${file} -af highpass=f=1500,lowpass=f=6000,volume=${gainDb}dB -ac 1 -ar 24000 -f f32le -`
      .quiet()
      .arrayBuffer()
  const x = new Float32Array(raw)
  const len = 120
  return Array.from({ length: Math.floor(x.length / len) }, (_, f) => {
    let sum = 0
    for (let i = f * len; i < (f + 1) * len; i++) {
      sum += (x[i] ?? 0) ** 2
    }
    return sum / len
  })
}

/** The stem's offset against the full mix, frames: where it least often exceeds the mix it is in. */
function stemLag(full: number[], stem: number[]): number {
  let best = { lag: 0, over: Number.POSITIVE_INFINITY }
  for (let lag = -40; lag <= 40; lag++) {
    let over = 0
    for (let f = 50; f < Math.min(full.length, stem.length) - 50; f++) {
      over += (stem[f + lag] ?? 0) > (full[f] ?? 0) * 1.05 ? 1 : 0
    }
    if (over < best.over) {
      best = { lag, over }
    }
  }
  return best.lag
}

/**
 * Each step onset in the feet stem against everything else in the same band over the next 60 ms:
 * the share of steps no more than 6 dB under the rest (audible as a click through the fight), and
 * the median step-to-rest ratio. The stem is taken before the master's 3 dB trim.
 */
async function footstepMasking(): Promise<{ steps: number; audible: number; medianDb: number }> {
  const full = await bandFrames(wav)
  const raw = await bandFrames(`${output}/${scene}.feet.wav`, -3)
  const lag = stemLag(full, raw)
  const feet = full.map((_, f) => raw[f + lag] ?? 0)
  const dB = (p: number) => 10 * Math.log10(p + 1e-12)
  const loud = Math.max(...feet)
  const ratios: number[] = []
  for (let f = 4; f < feet.length - 12; f++) {
    const before = ((feet[f - 4] ?? 0) + (feet[f - 3] ?? 0) + (feet[f - 2] ?? 0)) / 3
    if (dB(feet[f] ?? 0) < dB(loud) - 30 || dB(feet[f] ?? 0) < dB(before) + 6) {
      continue
    }
    let step = 0
    let rest = 0
    for (let k = f; k < f + 12; k++) {
      step += feet[k] ?? 0
      rest += Math.max((full[k] ?? 0) - (feet[k] ?? 0), 1e-10)
    }
    ratios.push(dB(step) - dB(rest))
    f += 12
  }
  ratios.sort((a, b) => a - b)
  return {
    steps: ratios.length,
    audible: Math.round((100 * ratios.filter((r) => r > -6).length) / Math.max(1, ratios.length)),
    medianDb: Math.round((ratios[Math.floor(ratios.length / 2)] ?? 0) * 10) / 10,
  }
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
console.log(`  plays ${JSON.stringify(counts)}`)
if (stats) {
  console.log(`  mix ${JSON.stringify(stats)}`)
}
const masking = await footstepMasking()
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
