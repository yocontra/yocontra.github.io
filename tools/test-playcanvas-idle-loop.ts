/** Mounted menu clocks and native skeletal loop frames; candidate assets stay outside public/. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import type { DuelActor } from '../src/experiments/out-west/duel/native-actor.ts'
import type { NativeDirector } from '../src/experiments/out-west/duel/native-director.ts'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4399'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-idle-loop'
const candidate = process.env.OW_IDLE_MOVES
const baseline = process.env.OW_BASELINE === '1'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/@vite/client', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: 'export const createHotContext=()=>({accept(){},dispose(){},on(){},off(){},send(){},prune(){},invalidate(){}});export const injectQuery=v=>v;export const updateStyle=()=>{};export const removeStyle=()=>{};',
    }),
  )
  if (candidate) {
    await page.route('**/native-v2/baked/moves.glb*', (route) => route.fulfill({ path: candidate }))
  }
  await page.goto(`${origin}/experiments/out-west/#debug`)
  await page.waitForFunction(
    () => Boolean(Reflect.get(globalThis, '__ow')?.director?.player?.model.anim?.baseLayer),
    undefined,
    { timeout: 90_000 },
  )
  // Observe the real menu without touching its animation clocks, then sample a whole 8s cycle.
  const cadence = await page.evaluate(async () => {
    const d: NativeDirector = Reflect.get(globalThis, '__ow').director
    const actor = d.player
    const layer = actor?.model.anim?.baseLayer
    if (!(actor && layer)) {
      throw new Error('Missing actual menu actor')
    }
    const samples: { wall: number; time: number; progress: number }[] = []
    const start = performance.now()
    for (let n = 0; n < 10; n++) {
      samples.push({
        wall: (performance.now() - start) / 1000,
        time: layer.activeStateCurrentTime,
        progress: layer.activeStateProgress,
      })
      if (n < 9) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    return {
      phase: d.phase,
      clip: layer.activeState,
      duration: actor.animationTrack(layer.activeState)?.duration,
      rate: actor.model.anim?.speed,
      timeScale: d.game.app.timeScale,
      samples,
    }
  })
  if (
    cadence.clip !== 'Idle_Character' ||
    cadence.duration !== 8 ||
    cadence.rate !== 1 ||
    cadence.timeScale !== 1
  ) {
    throw new Error(`Unexpected real menu clock: ${JSON.stringify(cadence)}`)
  }
  const elapsed = (cadence.samples.at(-1)?.time ?? 0) - (cadence.samples[0]?.time ?? 0)
  const wall = (cadence.samples.at(-1)?.wall ?? 0) - (cadence.samples[0]?.wall ?? 0)
  if (Math.abs(elapsed - wall) > 0.3) {
    throw new Error(`Menu clock drift: native ${elapsed}, wall ${wall}`)
  }
  await page.addStyleTag({
    content: '.ow-title,.ow-hub,.ow-hud,astro-dev-toolbar{visibility:hidden!important}',
  })
  const actorRecords = await page.evaluate(() => {
    const d: NativeDirector = Reflect.get(globalThis, '__ow').director
    d.paused = true
    d.game.app.timeScale = 0
    const folk = Reflect.get(d.atmosphere, 'folk') as { actor: DuelActor }[]
    const civilian = folk[0]?.actor
    if (!(d.player && civilian)) {
      throw new Error('Missing default outfit or civilian')
    }
    const actors = [d.player, civilian]
    Reflect.set(globalThis, '__idleActors', actors)
    for (const [index, actor] of actors.entries()) {
      actor.root.enabled = true
      actor.place(2.4 + index * 2, 0, 7.5)
      actor.face(0)
    }
    d.game.app.off('update', Reflect.get(d, 'tick'))
    d.game.camera.setPosition(3.4, 1.7, 12)
    d.game.camera.lookAt(3.4, 1.1, 7.5)
    return actors.map((actor) => ({
      name: actor.root.name,
      idleDuration: actor.animationTrack('Idle_Character')?.duration,
    }))
  })
  const frames: { clip: string; at: number; actors: { name: string; bone: number[] }[] }[] = []
  for (const clip of ['Idle_Character', 'Idle_Drunk', 'Idle_Shaky']) {
    for (const at of [7.95, 7.983_333, 8, 8.000_001, 8.016_667, 8.033_333, 8.1]) {
      const frame = await page.evaluate(
        ({ clip: requestedClip, at: requestedTime }) => {
          const actors: DuelActor[] = Reflect.get(globalThis, '__idleActors')
          const d: NativeDirector = Reflect.get(globalThis, '__ow').director
          for (const actor of actors) {
            actor.play(requestedClip, 0)
            actor.model.anim?.update(0)
            const layer = actor.model.anim?.baseLayer
            if (!layer) {
              throw new Error('Missing native idle layer')
            }
            layer.activeStateCurrentTime = requestedTime
            actor.model.anim?.update(0)
          }
          d.game.app.renderNextFrame = true
          return {
            clip: requestedClip,
            at: requestedTime,
            actors: actors.map((actor) => ({
              name: actor.root.name,
              bone: actor.model.findByName('UpperArmR')?.getLocalRotation().toArray() ?? [],
            })),
          }
        },
        { clip, at },
      )
      await page.screenshot({ path: `${output}/${clip}-${at.toFixed(6)}.png` })
      frames.push(frame)
    }
  }
  const distance = (a: number[], b: number[]) =>
    (2 *
      Math.acos(Math.min(1, Math.abs(a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0)))) *
      180) /
    Math.PI
  const seams = ['Idle_Character', 'Idle_Drunk', 'Idle_Shaky'].map((clip) => {
    const selected = frames.filter((frame) => frame.clip === clip)
    return {
      clip,
      jumps: [0, 1].map((actor) =>
        Math.max(
          ...selected
            .slice(1)
            .map((frame, i) =>
              distance(selected[i]?.actors[actor]?.bone ?? [], frame.actors[actor]?.bone ?? []),
            ),
        ),
      ),
    }
  })
  if (
    seams.some((seam) =>
      baseline ? (seam.jumps[0] ?? 0) < 100 : seam.jumps.some((angle) => angle > 5),
    )
  ) {
    throw new Error(`Unexpected native arm seam: ${JSON.stringify(seams)}`)
  }
  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }
  await writeFile(
    `${output}/results.json`,
    JSON.stringify({ cadence, actors: actorRecords, frames, seams, errors }, null, 2),
  )
  console.log(
    JSON.stringify({ cadence: { ...cadence, samples: undefined }, elapsed, wall, seams, errors }),
  )
} finally {
  await browser.close()
}
