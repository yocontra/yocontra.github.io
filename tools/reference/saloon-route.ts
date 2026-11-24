import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import type { FrontierSession } from '../../src/experiments/out-west/client/frontier-session.ts'
import type { GameInput } from '../../src/experiments/out-west/client/input.ts'
import type { GameViewport } from '../../src/experiments/out-west/client/viewport.ts'
import {
  configureRenderTicks,
  photographBar,
  photographDesert,
  setLight,
} from './frontier-camera.ts'

// Observe the final game mix after limiting, including any changes to the master volume.
export function prepareRouteAudio() {
  const nativeConnect = AudioNode.prototype.connect
  AudioNode.prototype.connect = function (
    this: AudioNode,
    ...args: Parameters<typeof nativeConnect>
  ) {
    const destination: unknown = args[0]
    if (this instanceof WaveShaperNode && destination === this.context.destination) {
      Reflect.set(globalThis, '__referenceMix', this)
    }
    return Reflect.apply(nativeConnect, this, args)
  } as typeof nativeConnect
}

const stops = [
  { name: 'street', x: 30, z: 51 },
  { name: 'threshold', x: 30.1, z: 43.1 },
  { name: 'bar', x: 30.05, z: 38.7 },
  { name: 'first-person-combat', x: 30.05, z: 38.7 },
  { name: 'aisle', x: 30.05, z: 42.8 },
  { name: 'stair-foot', x: 38, z: 42.8 },
  { name: 'stairs', x: 38, z: 35.3 },
  { name: 'stair-return', x: 38, z: 42.8 },
  { name: 'turn', x: 30.05, z: 42.8 },
  { name: 'third-person-combat', x: 30.05, z: 46.2 },
  { name: 'outside', x: 30, z: 54 },
]
// Leave the saloon roof walk, then follow the open alley to the cactus flats by the creek.
const roofStops = [
  { name: 'roof', x: 40.8, z: 45 },
  { name: 'roof-edge', x: 42.8, z: 45 },
  { name: 'alley', x: 43.55, z: 43 },
  { name: 'desert-edge', x: 43.65, z: 18.5 },
  { name: 'outside', x: 48.5, z: 13.5 },
]
interface RouteSample {
  name: string
  seconds: number
  tick: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  ammo: number
  reloading: number
  shots: number
}
interface Recorder {
  started: number
  pilotOffset: number
  roundSummaries: string[]
  done: Promise<string>
  samples: RouteSample[]
  peak: number
  restoreInput?: () => void
  finish: () => void
}

function startRecorder() {
  const audio = (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).audioContext()
  const canvas = document.querySelector<HTMLCanvasElement>('.pc-game-canvas')
  const mix = Reflect.get(globalThis, '__referenceMix') as WaveShaperNode | undefined
  if (!(audio && canvas && mix && mix.context === audio)) {
    throw new Error('Game canvas or mastered audio unavailable')
  }
  const destination = audio.createMediaStreamDestination()
  const meter = audio.createAnalyser()
  mix.connect(destination)
  mix.connect(meter)

  const video = canvas.captureStream(30)
  for (const track of destination.stream.getAudioTracks()) {
    video.addTrack(track)
  }
  const recorder = new MediaRecorder(video, {
    mimeType: 'video/webm;codecs=vp8,opus',
    videoBitsPerSecond: 2_000_000,
  })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data)
    }
  }
  const done = new Promise<string>((resolve, reject) => {
    recorder.onstop = () => {
      const file = new FileReader()
      file.onload = () => resolve(String(file.result).split(',')[1] ?? '')
      file.onerror = () => reject(file.error)
      file.readAsDataURL(new Blob(chunks, { type: 'video/webm' }))
    }
    recorder.onerror = () => reject(new Error('MediaRecorder failed'))
  })

  const state: Recorder = {
    started: performance.now(),
    pilotOffset: 0,
    roundSummaries: [],
    done,
    samples: [],
    peak: 0,
    finish() {
      state.restoreInput?.()
      recorder.stop()
      mix.disconnect(destination)
      mix.disconnect(meter)
      for (const track of video.getTracks()) {
        track.stop()
      }
    },
  }
  Reflect.set(globalThis, '__referenceRoute', state)

  Reflect.set(globalThis, '__referenceMeter', meter)
  recorder.start(1000)
}

async function startPilot(points: typeof stops) {
  const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
  const viewport = Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport
  const app = Reflect.get(globalThis, '__referenceApp') as import('playcanvas').AppBase | undefined
  const meter = Reflect.get(globalThis, '__referenceMeter') as AnalyserNode
  const wave = new Float32Array(meter.fftSize)
  const state = Reflect.get(globalThis, '__referenceRoute') as Recorder
  const inputPath = '/src/experiments/out-west/client/input.ts'
  const { GameInput: Input } = (await import(
    inputPath
  )) as typeof import('../../src/experiments/out-west/client/input.ts')
  const sample = Input.prototype.sample
  // A slow renderer can outlive the real-time practice round while input is still playing.
  const card = document.querySelector<HTMLElement>('.fr-summary')
  const rounds = new MutationObserver(() => {
    if (card && !card.hidden) {
      const again = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Ride again')
      if (again) {
        state.roundSummaries.push(card.textContent ?? '')
        again.click()
      }
    }
  })
  if (card) {
    rounds.observe(card, { attributes: true, attributeFilter: ['hidden'] })
  }
  state.restoreInput = () => {
    rounds.disconnect()
    Input.prototype.sample = sample
  }
  viewport.firstPerson(false)
  const start = performance.now()
  state.pilotOffset = (start - state.started) / 1000
  let index = 0
  let arrival: number | undefined
  let fired = false
  let firstShot = 0
  let sentReload = false

  const combatButtons = (hold: number, shots: number, reload: number) => {
    if (hold < 1.5) {
      return 2
    }
    if (!fired) {
      fired = shots > firstShot
      return 3
    }
    if (hold < 3) {
      return 2
    }
    sentReload ||= reload > 0
    return 8
  }
  const reachedStop = (combat: boolean, hold: number, reload: number) =>
    combat ? hold >= 10 && sentReload && reload === 0 : hold >= 5
  const onRoofRoute = points[0]?.name === 'roof'
  const poseAtStop = (name: string, input: GameInput) => {
    if (onRoofRoute && (name === 'roof' || name === 'desert-edge' || name === 'outside')) {
      input.yaw = name === 'roof' ? -1.2 : -1.45
      input.pitch = 0.02
    }
    if (name === 'bar' || name.endsWith('combat')) {
      input.yaw = name === 'third-person-combat' ? Math.PI : 1.45
      input.pitch = -0.06
    }
  }
  Input.prototype.sample = function (...args) {
    const intent = sample.apply(this, args)
    const p = session.world.players[session.selfSlot]
    if (!p) {
      return intent
    }
    const now = performance.now()
    const seconds = (now - start) / 1000
    const stop = points[index]
    if (!stop) {
      return intent
    }
    meter.getFloatTimeDomainData(wave)
    for (const v of wave) {
      state.peak = Math.max(state.peak, Math.abs(v))
    }
    const dx = stop.x - p.x
    const dz = stop.z - p.z
    const distance = Math.hypot(dx, dz)
    const combat = stop.name.endsWith('combat')
    if (arrival === undefined && distance > 0.28) {
      this.yaw = Math.atan2(-dx, -dz)
      this.pitch = 0
      return {
        ...intent,
        moveX: (0.75 * dx) / distance,
        moveZ: (0.75 * dz) / distance,
        yaw: this.yaw,
        pitch: 0,
        buttons: 0,
      }
    }
    if (arrival === undefined) {
      arrival = now
      firstShot = p.stats.shots
      sentReload = false
      fired = false
      viewport.firstPerson(stop.name === 'first-person-combat')
    }
    const hold = (now - arrival) / 1000
    poseAtStop(stop.name, this)
    const buttons = combat ? combatButtons(hold, p.stats.shots, p.reloadTicks) : 0
    const record = () => {
      if (app) {
        app.renderNextFrame = true
      }
      state.samples.push({
        name: stop.name,
        seconds,
        tick: session.world.tick,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: this.yaw,
        pitch: this.pitch,
        ammo: p.ammo,
        reloading: p.reloadTicks,
        shots: p.stats.shots,
      })
    }
    if (now === arrival || (p.reloadTicks > 0 && !state.samples.at(-1)?.reloading)) {
      record()
    }
    if (reachedStop(combat, hold, p.reloadTicks)) {
      record()
      index++
      arrival = undefined
    }
    return { ...intent, moveX: 0, moveZ: 0, yaw: this.yaw, pitch: this.pitch, buttons }
  }
}

function checkRoute(samples: RouteSample[], roof: boolean) {
  const highPoint = samples.find((point) => point.name === (roof ? 'roof' : 'stairs'))
  const outside = samples.at(-1)
  if (!highPoint || highPoint.y < 2.3 || outside?.name !== 'outside' || outside.y > 0.3) {
    throw new Error('The recorded route did not reach its high point and return to ground')
  }
  if (roof) {
    return
  }
  for (const name of ['first-person-combat', 'third-person-combat']) {
    const phase = samples.filter((point) => point.name === name)
    const before = phase[0]
    const after = phase.at(-1)
    if (
      !(before && after) ||
      after.shots !== before.shots + 1 ||
      before.ammo !== after.ammo ||
      !phase.some((point) => point.reloading > 0)
    ) {
      throw new Error(`Missing shot or completed reload during ${name}`)
    }
  }
}

export async function captureSaloonRoute(
  page: Page,
  options: {
    origin: string
    tier: string
    day: number
    roof: boolean
    out: string
    ticksPerFrame: number
  },
  receipts: object[],
) {
  const { origin, tier, day, out } = options
  const points = options.roof ? roofStops : stops
  const spawn = options.roof ? '40.8,45' : '30,57'
  await page.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=0&seed=7&spawn=${spawn}#tier=${tier}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__playcanvasFrontier')))
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' })
  console.info('Frontier loaded')
  if (options.ticksPerFrame > 0) {
    await page.evaluate(configureRenderTicks, options.ticksPerFrame)
  }
  await page.keyboard.press('Space')
  await page.evaluate(setLight, day)
  await page.evaluate(async () => {
    await (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).audioContext()?.resume()
  })
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__referenceMix')))
  if (options.roof) {
    await page.evaluate(() => {
      const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
      const rider = session.world.players[session.selfSlot]
      if (!rider) {
        throw new Error('Missing rider on the roof walk')
      }
      Object.assign(rider, { x: 40.8, y: 3.18, z: 45 })
    })
  }
  await page.evaluate(startRecorder)
  await page.evaluate(startPilot, points)
  console.info('Recording route with the game mix')
  const arrived = await page
    .waitForFunction(
      () => {
        const state = Reflect.get(globalThis, '__referenceRoute') as Recorder
        return state.samples.at(-1)?.name === 'outside' && state.samples.at(-2)?.name === 'outside'
      },
      null,
      { timeout: 900_000 },
    )
    .then(
      () => true,
      () => false,
    )
  const recorded = await page.evaluate(
    async (minimumSeconds) => {
      const state = Reflect.get(globalThis, '__referenceRoute') as Recorder
      const last = state.samples.at(-1)
      if (last?.name === 'outside' && last.seconds < minimumSeconds) {
        await new Promise((resolve) => setTimeout(resolve, (minimumSeconds - last.seconds) * 1000))
      }
      state.finish()
      return {
        data: await state.done,
        samples: state.samples,
        peak: state.peak,
        pilotOffset: state.pilotOffset,
        roundSummaries: state.roundSummaries,
      }
    },
    options.roof ? 0 : 90,
  )
  const rider = await page.evaluate(() => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const viewport = Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport
    return { outfit: session.appearance?.(session.selfId), viewport: viewport.debug() }
  })
  receipts.push({
    day,
    stops: points,
    samples: recorded.samples,
    peak: recorded.peak,
    pilotOffset: recorded.pilotOffset,
    roundSummaries: recorded.roundSummaries,
    rider,
  })
  await writeFile(
    join(out, options.roof ? 'roof-to-desert.webm' : 'saloon.webm'),
    Buffer.from(recorded.data, 'base64'),
  )
  if (!arrived) {
    throw new Error('The rider did not complete the saloon route. See capture.json.')
  }
  checkRoute(recorded.samples, options.roof)
  if (!(recorded.peak > 0)) {
    throw new Error('Game mix was silent')
  }
  if (options.roof) {
    await photographDesert(page, out)
  } else if (day < 1) {
    await photographBar(page, out)
  }
}
