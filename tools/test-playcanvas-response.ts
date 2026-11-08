/** Native page movement measurements. Desktop browser evidence, not physical iPhone certification. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, type Page } from 'playwright'
import type { FrontierSession } from '../src/experiments/out-west/client/frontier-session.ts'
import type { GameViewport } from '../src/experiments/out-west/client/viewport.ts'

interface Sample {
  at: number
  x: number
  z: number
  vx: number
  vz: number
  clip: string
  authoritativeX: number
  authoritativeZ: number
  authoritativeSeq: number
  predictedSeq: number
  tick: number
}
type Probe = Partial<
  Record<'__playcanvasFrontier', GameViewport> &
    Record<'__nativeFrontierSession', FrontierSession> &
    Record<'__motionSamples', Sample[]> &
    Record<'__releaseAt', number>
>

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'
const api = process.env.OW_API ?? 'http://127.0.0.1:8792'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-response-final'
const reservationDelayMs = Number(process.env.OW_RESERVATION_DELAY_MS ?? 0)
let reservationDelayed = false
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
const sentFrames = new WeakMap<Page, { at: number; count: number }[]>()

async function open(mode: 'local' | 'remote', lobby?: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', (error) => errors.push(error.message.split('?')[0] ?? 'Page error'))
  const frames: { at: number; count: number }[] = []
  sentFrames.set(page, frames)
  page.on('websocket', (socket) => {
    if (socket.url().includes('/town/')) {
      socket.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string' && payload[0] === 254) {
          frames.push({ at: Date.now(), count: payload[1] ?? 0 })
        }
      })
    }
  })
  await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
  const url = new URL(`${origin}/experiments/out-west/frontier/`)
  if (mode === 'local') {
    url.search = new URLSearchParams({
      server: 'loopback',
      bots: '0',
      seed: '7',
      spawn: '72,66',
    }).toString()
  } else {
    if (reservationDelayMs > 0 && !reservationDelayed) {
      reservationDelayed = true
      await page.route(`${api}/town/native/join`, async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue()
          return
        }
        const response = await route.fetch()
        await new Promise((resolve) => setTimeout(resolve, reservationDelayMs))
        await route.fulfill({ response })
      })
    }
    const account = await (await fetch(`${api}/__test/seed`)).json()
    url.searchParams.set('server', 'remote')
    url.searchParams.set('api', api)
    url.searchParams.set('token', account.token)
    if (lobby) {
      url.searchParams.set('lobby', lobby)
    }
  }
  await page.goto(url.href, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (globalThis as Probe).__playcanvasFrontier, undefined, {
    timeout: 90_000,
  })
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' })
  return page
}

function observe(page: Page, id: string): Promise<string> {
  return page.evaluate(async (rider) => {
    const source = await (await fetch('/src/experiments/out-west/client/application.ts')).text()
    const path = source
      .split('\n')
      .find((line) => line.includes('from ') && line.includes('playcanvas'))
      ?.replaceAll("'", '"')
      .split('"')[1]
    if (!path) {
      throw new Error('Missing native engine URL')
    }
    const pc: typeof import('playcanvas') = await import(/* @vite-ignore */ path)
    const applications = Reflect.get(pc.AppBase, '_applications')
    const app = Reflect.get(applications, '') as InstanceType<typeof pc.AppBase>
    const state = globalThis as Probe
    const samples: Sample[] = []
    state.__motionSamples = samples
    if (state.__nativeFrontierSession?.selfId === rider) {
      document.addEventListener(
        'keyup',
        (event) => {
          if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) {
            state.__releaseAt = Date.now()
          }
        },
        { once: true },
      )
    }
    const started = Date.now()
    const sample = (): void => {
      const model = app.root.find(
        (node) =>
          Boolean(Reflect.get(node, 'anim')) && Boolean(node.parent?.tags.has(`rider:${rider}`)),
      )[0] as InstanceType<typeof pc.Entity> | undefined
      const session = state.__nativeFrontierSession
      const pose = session?.players.get(rider)
      const authority = session?.world.players[Number(rider)]
      if (model?.parent && model.anim?.baseLayer && pose && authority && session) {
        const position = model.parent.getPosition()
        samples.push({
          at: Date.now(),
          x: position.x,
          z: position.z,
          vx: pose.vx,
          vz: pose.vz,
          clip: model.anim.baseLayer.activeState,
          authoritativeX: authority.x,
          authoritativeZ: authority.z,
          authoritativeSeq: authority.lastSeq,
          predictedSeq: pose.seq,
          tick: session.world.tick,
        })
      }
      if (Date.now() - started < 4000) {
        requestAnimationFrame(sample)
      }
    }
    requestAnimationFrame(sample)
    const session = state.__nativeFrontierSession
    const pose = session?.players.get(rider)
    if (!(session && pose)) {
      throw new Error('Missing native motion pose')
    }
    const sin = Math.sin(pose.yaw)
    const cos = Math.cos(pose.yaw)
    const directions = [
      ['KeyW', -sin, -cos],
      ['KeyD', cos, -sin],
      ['KeyS', sin, cos],
      ['KeyA', -cos, sin],
    ] as const
    for (const [key, dx, dz] of directions) {
      const clear = [-0.4, 0, 0.4].every((offset) => {
        const start = new pc.Vec3(pose.x - dz * offset, pose.y + 0.1, pose.z + dx * offset)
        const end = new pc.Vec3(start.x + dx * 4.5, start.y, start.z + dz * 4.5)
        return !session.cameraTrace?.(start, end)
      })
      if (clear) {
        return key
      }
    }
    throw new Error('No unobstructed native motion probe path')
  }, id)
}

function measure(label: string, samples: Sample[], release: number) {
  const after = samples.filter((sample) => sample.at >= release)
  const end = after.at(-1)
  const moving = samples.some((sample) => Math.hypot(sample.vx, sample.vz) > 0.5)
  if (!(end && moving)) {
    throw new Error(`${label}: did not observe actual movement`)
  }
  const first = samples[0]
  const before =
    label === 'networked observing another rider'
      ? samples
      : samples.filter((sample) => sample.at <= release)
  if (
    !(first && before.some((sample) => Math.hypot(sample.x - first.x, sample.z - first.z) > 2.5))
  ) {
    throw new Error(`${label}: blocked path did not travel2.5m`)
  }
  const settled = after.find((_, index) =>
    after.slice(index).every((sample) => Math.hypot(sample.x - end.x, sample.z - end.z) < 0.005),
  )
  const idleSample = after[after.findLastIndex((sample) => !sample.clip.startsWith('Idle')) + 1]
  const stopped = after.find((_, index) =>
    after.slice(index).every((sample) => Math.hypot(sample.vx, sample.vz) < 0.01),
  )
  return {
    label,
    releaseClock: 'Date.now at actual keyboard release',
    positionStopMs: settled ? settled.at - release : null,
    clipStopMs: idleSample ? idleSample.at - release : null,
    renderedVelocityStopMs: stopped ? stopped.at - release : null,
    samples: samples.map((sample) => ({ ...sample, at: sample.at - release })),
  }
}

const results: (ReturnType<typeof measure> & { packets: { at: number; count: number }[] })[] = []
const failures: string[] = []
try {
  for (const mode of ['local', 'remote'] as const) {
    const own = await open(mode)
    const info = await own.evaluate(() => {
      const session = (globalThis as Probe).__nativeFrontierSession
      if (!session) {
        throw new Error('Missing native session')
      }
      return { id: session.selfId, lobby: session.lobbyId }
    })
    const observer = mode === 'remote' ? await open('remote', info.lobby) : undefined
    if (observer) {
      await observer.waitForFunction(
        (id) => (globalThis as Probe).__nativeFrontierSession?.players.has(id),
        info.id,
      )
      await observe(observer, info.id)
    }
    const movementKey = await observe(own, info.id)
    const heldAt = Date.now()
    await own.keyboard.down(movementKey)
    await own.waitForFunction((start) => Date.now() - start >= 650, heldAt)
    await own.keyboard.up(movementKey)
    const release = await own.evaluate(() => (globalThis as Probe).__releaseAt)
    if (!release) {
      throw new Error('Missing actual keyboard release')
    }
    await own.waitForFunction(
      (at) => ((globalThis as Probe).__motionSamples?.at(-1)?.at ?? 0) >= at + 1200,
      release,
    )
    for (const [label, page] of [
      [`${mode} own rider`, own],
      ['networked observing another rider', observer],
    ] as const) {
      if (!page) {
        continue
      }
      const samples = await page.evaluate(() => (globalThis as Probe).__motionSamples ?? [])
      const packets = (sentFrames.get(own) ?? []).filter(
        (frame) => frame.at >= release - 650 && frame.at <= release + 1200,
      )
      const result = {
        ...measure(label, samples, release),
        packets: packets.map((frame) => ({ ...frame, at: frame.at - release })),
      }
      results.push(result)
      console.log(JSON.stringify({ ...result, samples: undefined }))
      if (result.positionStopMs === null || result.clipStopMs === null) {
        failures.push(`${label}: never stopped`)
      }
      if (label.endsWith('own rider') && (result.positionStopMs ?? 9999) > 150) {
        failures.push(`${label}: visible extra coast`)
      }
      if (
        label === 'networked observing another rider' &&
        Math.abs((result.clipStopMs ?? 9999) - (result.positionStopMs ?? 9999)) > 100
      ) {
        failures.push('Observed rider animation did not follow displayed movement')
      }
    }
    await own.screenshot({ path: `${output}/${mode}-stopped.png` })
    await own.close()
    await observer?.close()
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n'))
  }
  if (errors.length > 0) {
    throw new Error(`Native page errors: ${JSON.stringify(errors)}`)
  }
} finally {
  await writeFile(
    `${output}/measurements.json`,
    JSON.stringify({ reservationDelayMs, results, errors, failures }, null, 2),
  )
  await browser.close()
}
