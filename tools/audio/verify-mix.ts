// biome-ignore-all lint/security/noSecrets: engine calls and captions in page scripts, not secrets
// biome-ignore-all lint/suspicious/noPlaywrightWaitForTimeout: real-time playback: waits are listening time
/**
 * The mix, moment by moment (`tools/audio/MIX.md`), in real Chrome through the `#audiodebug` taps:
 * each screen's song at its resting level, the duel's walk and standoff (the cue, ducked), an
 * outlaw's lines over the walk, and the stings. Then, offline, how each file translates to a phone
 * speaker (nothing under 300 Hz, little over 8 kHz).
 *
 *   PLAYWRIGHT=/abs/path/to/node_modules/playwright bun tools/audio/verify-mix.ts [baseUrl] [--offline]
 *
 * Reports the RMS of the output and of each bus per moment (dB, full scale), so screens can be
 * held to the targets in MIX.md.
 */
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { load, loudness } from './dsp.ts'

interface Frame {
  t: number
  tap: string
  peak: number
  rms: number
}
interface PageLike {
  goto: (url: string) => Promise<unknown>
  waitForFunction: (fn: string, arg?: unknown, opts?: { timeout?: number }) => Promise<unknown>
  evaluate: <T>(fn: string) => Promise<T>
  mouse: { click: (x: number, y: number) => Promise<void> }
  waitForTimeout: (ms: number) => Promise<void>
}
interface Pw {
  chromium: {
    launch: (o: unknown) => Promise<{
      newPage: (o: unknown) => Promise<PageLike>
      close: () => Promise<void>
    }>
  }
}

const PUB = resolve(import.meta.dir, '../../public/experiments/out-west/3d')
const base = process.argv.find((a) => a.startsWith('http')) ?? 'http://localhost:4388'
const f1 = (n: number) => n.toFixed(1).padStart(6)
const rmsDb = (xs: number[]) =>
  xs.length > 0 ? 10 * Math.log10(xs.reduce((a, d) => a + 10 ** (d / 10), 0) / xs.length) : -200

/** A phone speaker: nothing below 300 Hz, a soft top above 8 kHz. */
const PHONE = 'highpass=f=300:poles=2,highpass=f=300:poles=2,lowpass=f=8000'

function offline(): void {
  console.log('\nphone speaker translation (integrated LUFS, full band → phone band):')
  const rows: [string, number, number][] = []
  for (const dir of ['music', 'voice']) {
    for (const f of readdirSync(`${PUB}/${dir}`).filter((x) => x.endsWith('.m4a'))) {
      const p = `${PUB}/${dir}/${f}`
      const full = loudness(load(p, 2)).lufs
      const phone = loudness(load(p, 2, PHONE)).lufs
      rows.push([`${dir}/${f}`, full, phone])
    }
  }
  for (const [n, full, phone] of rows) {
    console.log(`  ${n.padEnd(28)} ${f1(full)} → ${f1(phone)}  (loses ${f1(full - phone)} dB)`)
  }
  const avg = (pre: string) => {
    const r = rows.filter(([n]) => n.startsWith(pre))
    return r.reduce((a, [, f, p]) => a + (f - p), 0) / r.length
  }
  console.log(
    `  mean loss: music ${avg('music').toFixed(1)} dB, voice ${avg('voice').toFixed(1)} dB (voice gains ${(avg('music') - avg('voice')).toFixed(1)} dB on music on a phone)`,
  )
}

async function live(): Promise<void> {
  const { chromium } = (await import(process.env.PLAYWRIGHT ?? 'playwright')) as Pw
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.goto(`${base}/experiments/out-west/#audiodebug`)
  await page.waitForTimeout(1500)
  await page.mouse.click(640, 360)
  await page.waitForFunction('globalThis.__owAudioEngine !== undefined', undefined, {
    timeout: 30_000,
  })
  const E = 'globalThis.__owAudioEngine'
  await page.evaluate(`${E}.loadVoice('Prescott J. House')`)
  await page.waitForTimeout(3000)
  const measure = async (label: string, setup: string, settle: number, secs: number) => {
    await page.evaluate(`(() => { const e = ${E}; ${setup} })()`)
    await page.waitForTimeout(settle * 1000)
    const from = await page.evaluate<number>('globalThis.__owAudio.ctx.currentTime')
    await page.waitForTimeout(secs * 1000)
    const fr = await page.evaluate<Frame[]>(
      `globalThis.__owAudio.frames.filter((f) => f.t >= ${from})`,
    )
    const tap = (n: string) => fr.filter((f) => f.tap === n)
    const pk = Math.max(...tap('out').map((f) => f.peak))
    console.log(
      `${label.padEnd(26)} out ${f1(rmsDb(tap('out').map((f) => f.rms)))}  music ${f1(rmsDb(tap('music').map((f) => f.rms)))}  voice ${f1(rmsDb(tap('voice').map((f) => f.rms)))}  amb ${f1(rmsDb(tap('amb').map((f) => f.rms)))}  peak ${f1(pk)}`,
    )
  }
  console.log('moment                     (RMS dBFS over the window; peak of the output)')
  const song = (name: string) =>
    `e.stopAmbience(); e.musicLevel(0, 0.05); e.musicLowpass(18000, 0.05); e.playSong('${name}')`
  for (const s of [
    'intro',
    'saloon',
    'saloonB',
    'actDay',
    'actDusk',
    'actNight',
    'boss',
    'frontier',
  ]) {
    await measure(s, song(s), 3, 6)
  }
  await measure('walk (day cue −6, 9k)', `${song('actDay')}; e.setTimeOfDay(0.1)`, 2, 0)
  await measure(
    'walk (day cue −6, 9k)',
    "e.musicSection('duel'); e.musicLevel(-6, 0.3); e.musicLowpass(9000, 0.3)",
    2.5,
    5,
  )
  await measure(
    'walk + talker lines',
    "e.voiceLine('Prescott J. House', 'Three! Smell that? That’s fear.')",
    0.3,
    2.4,
  )
  await measure(
    'standoff (cue −13, 3k)',
    'e.musicLevel(-13, 0.3); e.musicLowpass(3000, 0.3)',
    1.5,
    5,
  )
  await measure(
    'sting victoryBig',
    "e.musicLevel(0, 0.4); e.musicLowpass(18000, 0.4); e.playSting('victoryBig')",
    0.1,
    3,
  )
  await measure('sting defeat', "e.playSting('defeat')", 0.1, 3)
  await browser.close()
}

if (!process.argv.includes('--offline')) {
  await live()
}
offline()
