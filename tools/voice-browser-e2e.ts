/**
 * Proximity voice, end to end in the real Frontier client: two signed-in players in one lobby, the
 * opt-in switch in the pause menu, push-to-talk, the remote audio track arriving, and the panner
 * following the speaker. Also checks the control steps out of the pause card's way and disappears
 * when voice is switched off again.
 *
 *   bunx wrangler dev --config api/wrangler.jsonc --local --port 8799 --inspector-port 9239 \
 *     --infer-origin-from-routes=false
 *   PUBLIC_API_URL=http://localhost:8799 bun run dev --port 4370
 *   bun tools/voice-browser-e2e.ts [--site http://localhost:4370]
 *
 * `api/.dev.vars` needs the RealtimeKit app, preset and token, and `RP_ORIGINS` and
 * `ALLOWED_ORIGINS` must include the site origin. Not part of `bun test`.
 */
// biome-ignore-all lint/suspicious/noConsole: a CLI harness reports to the terminal
// biome-ignore-all lint/performance/noAwaitInLoops: a CLI harness polls one page at a time
// biome-ignore-all lint/style/useGlobalThis: these snippets run in the browser page, where window is the global
// biome-ignore-all lint/style/useNamingConvention: the page's dev hooks are snake-ish (__frontier, __frontierPilot)
import process from 'node:process'
// biome-ignore lint/correctness/noUnresolvedImports: playwright's CommonJS re-exports are invisible to Biome
import { chromium } from 'playwright'
import { check, failed, openLocalD1, seedPlayer } from '../api/test/local-d1.ts'

const arg = (flag: string, fallback: string): string => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}
const SITE = arg('--site', 'http://localhost:4370')
const db = openLocalD1()
const a = await seedPlayer(db, { name: 'Voice A', ip: '10.91.0.1', clears: 7 })
const b = await seedPlayer(db, { name: 'Voice B', ip: '10.91.0.2', clears: 7 })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Page instrumentation: remote audio counters, the local sender, and the voice panner. */
function instrument(): void {
  const w = window as unknown as Record<string, unknown>
  w.__panners = []
  w.__pcs = []
  w.__inTracks = []
  const params = new WeakMap<AudioParam, { rec: Record<string, unknown>; axis: string }>()
  const origSet = AudioParam.prototype.setTargetAtTime
  AudioParam.prototype.setTargetAtTime = function patchedSet(v: number, t: number, c: number) {
    const slot = params.get(this)
    if (slot) {
      slot.rec[slot.axis] = v
    }
    return origSet.call(this, v, t, c)
  }
  const nodeRec = new WeakMap<AudioNode, { disposed: boolean }>()
  const origDisconnect = AudioNode.prototype.disconnect
  AudioNode.prototype.disconnect = function patchedDisconnect(this: AudioNode, ...args: unknown[]) {
    const rec = nodeRec.get(this)
    if (rec) {
      rec.disposed = true
    }
    return Reflect.apply(origDisconnect, this, args)
  } as typeof origDisconnect
  const origPanner = AudioContext.prototype.createPanner
  AudioContext.prototype.createPanner = function patchedPanner(this: AudioContext) {
    const panner = origPanner.call(this)
    const rec = { node: panner, x: null as number | null, y: null, z: null, disposed: false }
    params.set(panner.positionX, { rec, axis: 'x' })
    params.set(panner.positionY, { rec, axis: 'y' })
    params.set(panner.positionZ, { rec, axis: 'z' })
    nodeRec.set(panner, rec)
    ;(w.__panners as unknown[]).push(rec)
    return panner
  }
  const OrigPC = window.RTCPeerConnection
  window.RTCPeerConnection = new Proxy(OrigPC, {
    construct(target, args) {
      const pc = Reflect.construct(target, args) as RTCPeerConnection
      ;(w.__pcs as RTCPeerConnection[]).push(pc)
      pc.addEventListener('track', (e) => {
        ;(w.__inTracks as unknown[]).push({ kind: e.track.kind, id: e.track.id })
      })
      return pc
    },
  }) as typeof RTCPeerConnection
  w.__voiceStats = async () => {
    let bytes = 0
    const reports = await Promise.all((w.__pcs as RTCPeerConnection[]).map((pc) => pc.getStats()))
    for (const stats of reports) {
      for (const r of stats.values()) {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          bytes += Number(r.bytesReceived ?? 0)
        }
      }
    }
    return { bytes, tracks: w.__inTracks }
  }
  w.__voicePanner = () => {
    const list = w.__panners as {
      node: PannerNode
      x: number | null
      y: number | null
      z: number | null
      disposed: boolean
    }[]
    const hit = list.find(
      (r) => !r.disposed && r.node.refDistance === 5 && r.node.maxDistance === 28,
    )
    return hit ? { x: hit.x, y: hit.y, z: hit.z } : null
  }
  w.__outMic = () => {
    for (const pc of w.__pcs as RTCPeerConnection[]) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === 'audio') {
          return sender.track.enabled
        }
      }
    }
    return null
  }
}

const browser = await chromium.launch({
  channel: 'chrome',
  args: [
    '--use-angle=metal',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // Two pages must both run their netcode: do not throttle the one that is not in front.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // biome-ignore lint/security/noSecrets: a Chrome feature name, not a credential
    '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
  ],
})

async function open(token: string): Promise<{ page: import('playwright').Page }> {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
    permissions: ['microphone'],
  })
  await ctx.addInitScript(instrument)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('page error:', e.message))
  const url = `${SITE}/experiments/out-west/frontier/?server=remote&lobby=lobby:0&bots=0&debug&token=${token}`
  await page.goto(url)
  await page.waitForFunction(
    () =>
      (window as unknown as { __frontier?: () => { alive: boolean } }).__frontier?.().alive ===
      true,
    undefined,
    { timeout: 120_000 },
  )
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none !important}' })
  return { page }
}

const A = await open(a.token)
const B = await open(b.token)

const debug = (page: import('playwright').Page) =>
  page.evaluate(() =>
    (
      window as unknown as {
        __frontier: () => {
          x: number
          z: number
          alive: boolean
          you: number
          others: { id: number }[]
        }
      }
    ).__frontier(),
  )

// The round places the riders a moment after the first snapshot lands.
await sleep(6000)
const a0 = await debug(A.page)
const b0 = await debug(B.page)
console.log('spawns', {
  a: { x: a0.x, z: a0.z, you: a0.you },
  b: { x: b0.x, z: b0.z, you: b0.you },
})
check('both riders are in the same lobby', a0.you !== b0.you, { a: a0.you, b: b0.you })

// Walk A next to B. The server owns the spawn; the autopilot sends the same input frames a
// player would, so the proximity ranking sees a real approach.
const bPos = { x: b0.x, z: b0.z }
await A.page.evaluate(
  ([x, z]) =>
    (
      window as unknown as {
        __frontier: () => { x: number; z: number }
        __frontierPilot: { go: (x: number, z: number) => boolean }
      }
    ).__frontierPilot.go(Number(x) - 3, Number(z) - 3),
  [bPos.x, bPos.z],
)
for (let i = 0; i < 150; i++) {
  const d = await debug(A.page)
  if (Math.hypot(d.x - bPos.x, d.z - bPos.z) < 6) {
    break
  }
  await sleep(400)
}
await A.page.evaluate(() =>
  (window as unknown as { __frontierPilot: { stop: () => void } }).__frontierPilot.stop(),
)
const arrived = await debug(A.page)
check(
  'A ends up near B (both see each other)',
  arrived.alive && arrived.others.some((o: { id: number }) => o.id === b0.you),
  { a: { x: arrived.x, z: arrived.z }, b: { x: b0.x, z: b0.z }, seen: arrived.others },
)

async function dismissHowTo(page: import('playwright').Page): Promise<void> {
  await page.evaluate(() =>
    (
      window as unknown as { __frontierView: { closeHowTo: () => void } }
    ).__frontierView.closeHowTo(),
  )
  await sleep(250)
  if (await page.locator('.fr-howto').isVisible()) {
    await page.evaluate(() =>
      (
        window as unknown as { __frontierView: { closeHowTo: () => void } }
      ).__frontierView.closeHowTo(),
    )
    await sleep(250)
  }
}

async function enableVoice(page: import('playwright').Page): Promise<void> {
  await dismissHowTo(page)
  await page.locator('.fr-menu-btn').tap()
  await page.locator('.fr-menu.on').waitFor({ timeout: 10_000 })
  await page.locator('label.fr-set-check', { hasText: 'Proximity voice' }).locator('input').tap()
  // The control must not sit over the paused card.
  await sleep(500)
  check(
    'the talk control hides behind the pause card',
    !(await page.locator('.ow-voice').isVisible()),
  )
  await page.locator('.fr-menu-x').tap()
  await page.locator('.ow-voice.on').waitFor({ timeout: 20_000 })
  await page.waitForFunction(
    () => document.querySelector('.ow-voice-btn')?.textContent === 'TALK',
    undefined,
    { timeout: 45_000 },
  )
}

await enableVoice(A.page)
await enableVoice(B.page)
check(
  'both pages reach a live RealtimeKit session',
  (await A.page.locator('.ow-voice-btn').textContent()) === 'TALK' &&
    (await B.page.locator('.ow-voice-btn').textContent()) === 'TALK',
)

await sleep(1500)
const aNear = await debug(A.page)
const panner = await B.page.evaluate(() =>
  (
    window as unknown as { __voicePanner: () => { x: number; y: number; z: number } | null }
  ).__voicePanner(),
)
check(
  'B has a positional voice panner on A',
  panner !== null && Math.hypot((panner.x ?? 0) - aNear.x, (panner.z ?? 0) - aNear.z) < 3,
  { panner, aNear },
)

const before = await B.page.evaluate(() =>
  (window as unknown as { __voiceStats: () => Promise<unknown> }).__voiceStats(),
)
await A.page
  .locator('.ow-voice-btn')
  .dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', bubbles: true })
await sleep(1500)
const talking = await A.page.evaluate(() =>
  (window as unknown as { __outMic: () => boolean | null }).__outMic(),
)
check('push-to-talk enables the microphone', talking === true, talking)
const after = await B.page.evaluate(() =>
  (window as unknown as { __voiceStats: () => Promise<unknown> }).__voiceStats(),
)
await A.page
  .locator('.ow-voice-btn')
  .dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', bubbles: true })
await sleep(300)
const released = await A.page.evaluate(() =>
  (window as unknown as { __outMic: () => boolean | null }).__outMic(),
)
check('releasing push-to-talk closes the microphone', released === false, released)
check(
  'B receives the remote audio track and bytes',
  (after as { bytes: number }).bytes > (before as { bytes: number }).bytes + 500 &&
    (after as { tracks: { kind: string }[] }).tracks.some((t) => t.kind === 'audio'),
  { before, after },
)

// Move A: B's panner follows.
const pan0 = await B.page.evaluate(() =>
  (window as unknown as { __voicePanner: () => { x: number } | null }).__voicePanner(),
)
await A.page.evaluate(() => {
  const f = window as unknown as {
    __frontier: () => { x: number; z: number }
    __frontierPilot: { go: (x: number, z: number) => boolean }
  }
  const d = f.__frontier()
  f.__frontierPilot.go(d.x + 8, d.z)
})
await sleep(5000)
await A.page.evaluate(() =>
  (window as unknown as { __frontierPilot: { stop: () => void } }).__frontierPilot.stop(),
)
await sleep(800)
const pan1 = await B.page.evaluate(() =>
  (window as unknown as { __voicePanner: () => { x: number } | null }).__voicePanner(),
)
check(
  'the panner follows the moving speaker',
  pan0 !== null && pan1 !== null && Math.abs(pan1.x - pan0.x) > 3,
  { pan0, pan1 },
)

// Off again: the control goes away.
await dismissHowTo(A.page)
await A.page.locator('.fr-menu-btn').tap()
await A.page.locator('.fr-menu.on').waitFor()
await A.page.locator('label.fr-set-check', { hasText: 'Proximity voice' }).locator('input').tap()
await A.page.locator('.fr-menu-x').tap()
await sleep(1000)
check('switching voice off hides the control', (await A.page.locator('.ow-voice.on').count()) === 0)

await browser.close()
process.exit(failed() === 0 ? 0 : 1)
