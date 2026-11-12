// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: a firefight is recorded in real time
// biome-ignore-all lint/style/useNamedCaptureGroup: one-number captures from ffmpeg logs
// biome-ignore-all lint/performance/useTopLevelRegex: ffmpeg log parsing, run once
/**
 * Record a real Frontier firefight in Chrome for listening and mix measurement: the local rider
 * strafes and fires in the main street while `bots` riders fight around them. Writes the page's
 * actual output (`<scene>.wav`), the play log, and prints the integrated loudness, true peak, the
 * mix's per-category meters and how many sounds each voice budget let through.
 *
 *   OW_ORIGIN=http://127.0.0.1:4390 bun tools/audio/frontier-firefight.ts <scene> <bots> [seconds] [--listen]
 *
 * `--listen` asks Gemini to score the recording for density, masking and readability.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import type {
  FrontierAudio,
  PlayedSound,
} from '../../src/experiments/out-west/client/frontier-audio.ts'
import type { GameViewport } from '../../src/experiments/out-west/client/viewport.ts'
import { listen } from './vendors.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-frontier-audio'
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const [scene = 'firefight', botsArg = '4', secondsArg = '30'] = argv
const bots = Number(botsArg)
const seconds = Number(secondsArg)
await mkdir(output, { recursive: true })

const PROMPT = `You are a strict AAA game audio director reviewing a ${seconds}-second capture of a dense multiplayer western shooter firefight (${bots} AI riders fighting around the listener, who strafes and fires a revolver). Target: Call of Duty Mobile competitive readability with Red Dead Redemption 2 grounded western sound. Judge: (1) masking: can you tell the listener's own gun from enemy fire, and hear bullet impacts, hit markers and nearby enemy FOOTSTEPS through the gunfire? (2) density: does the fight stay clear and punchy or collapse into a wall of sound? (3) dynamics: pumping, clipping, harshness, spikes. (4) repetition: are any sounds obviously looped/identical? (5) ambience: does the town bed survive between bursts? Reply with JSON only: {"heard": string (timestamped notable events), "masking": 1-10, "density": 1-10, "dynamics": 1-10, "repetition": 1-10, "footstepsReadable": boolean, "ownGunDistinct": boolean, "overall": 1-10, "problems": string}`

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
  globalThis.__startRecording = () => {
    const chunks = []
    const rec = new MediaRecorder(globalThis.__tap.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 256000 })
    rec.ondataavailable = (e) => chunks.push(e.data)
    rec.start(250)
    globalThis.__stopRecording = () => new Promise((done) => {
      rec.onstop = async () => {
        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
        let s = ''
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        done(btoa(s))
      }
      rec.stop()
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
  `${origin}/experiments/out-west/frontier/?server=loopback&bots=${bots}&cluster&seed=7&spawn=72,66`,
  { waitUntil: 'domcontentloaded' },
)
await page.waitForFunction(
  () => Boolean((Reflect.get(globalThis, '__frontierAudio') as FrontierAudio | undefined)?.context),
  undefined,
  { timeout: 90_000 },
)
await page.waitForTimeout(2500)
const t0 = await page.evaluate(() => {
  ;(Reflect.get(globalThis, '__startRecording') as () => void)()
  return (Reflect.get(globalThis, '__frontierAudio') as FrontierAudio).clock
})
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
    await page.waitForTimeout(450 + Math.random() * 300)
  }
  await page.keyboard.up(side)
  side = side === 'KeyA' ? 'KeyD' : 'KeyA'
  if (++n % 5 === 0) {
    await page.keyboard.press('KeyR')
    await page.waitForTimeout(900)
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
await browser.close()

const webm = `${output}/${scene}.webm`
const wav = `${output}/${scene}.wav`
await writeFile(webm, Buffer.from(audio, 'base64'))
await writeFile(`${output}/${scene}.log.json`, JSON.stringify(played, null, 1))
await Bun.$`ffmpeg -y -loglevel error -i ${webm} -ar 48000 ${wav}`
const meter = (
  await Bun.$`ffmpeg -hide_banner -nostats -i ${wav} -af ebur128=peak=true -f null -`
    .nothrow()
    .quiet()
).stderr.toString()
const summary = meter.slice(meter.lastIndexOf('Summary:'))
const integrated = /I:\s+(-?[\d.]+) LUFS/u.exec(summary)?.[1]
const range = /LRA:\s+(-?[\d.]+) LU/u.exec(summary)?.[1]
const peak = /Peak:\s+(-?[\d.]+) dBFS/u.exec(summary)?.[1]
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
if (errors.length > 0) {
  console.log(`  page errors: ${errors.slice(0, 3).join(' | ')}`)
}
if (process.argv.includes('--listen')) {
  const once = () => listen(wav, PROMPT)
  const verdict = await once()
    .catch(once)
    .catch((e: unknown) => `error: ${String(e).slice(0, 200)}`)
  await writeFile(`${output}/${scene}.listen.txt`, verdict)
  console.log(`  listen ${verdict.replaceAll(/\s+/gu, ' ')}`)
}
