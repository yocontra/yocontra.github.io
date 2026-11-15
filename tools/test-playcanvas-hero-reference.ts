/** Inspect the isolated anatomical candidate in the actual mounted native duel renderer. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import type { GameApplication } from '../src/experiments/out-west/client/application.ts'
import type { DuelActor } from '../src/experiments/out-west/duel/native-actor.ts'

const base = process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4397'
const output = process.env.OUT_WEST_OUTPUT ?? '/tmp/out-west-hero-native'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
const records: unknown[] = []
interface Debug {
  director: {
    game: GameApplication
    paused: boolean
    player: DuelActor
    enemy: DuelActor
    phase: string
  }
}
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await page.routeWebSocket(`ws://${new URL(base).host}/**`, (socket) => socket.close())
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/experiments/out-west/#debug&level=1`)
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), null, {
    timeout: 60_000,
  })
  await page.locator('.ow-start').click()
  await page.waitForFunction(
    () => (Reflect.get(globalThis, '__ow') as Debug).director.phase === 'cock',
  )
  await page.locator('.ow-start').waitFor({ state: 'hidden' })
  await page.evaluate(async () => {
    const d = (Reflect.get(globalThis, '__ow') as Debug).director
    d.paused = true
    d.game.app.timeScale = 0
    d.player.root.enabled = false
    d.enemy.root.enabled = false
    const path = '/src/experiments/out-west/duel/native-actor.ts'
    const { DuelActor: NativeActor } = await import(/* @vite-ignore */ path)
    const actor: DuelActor = await NativeActor.create(
      d.game,
      '/experiments/out-west/3d/native-v2/reference/baked/player.glb',
      'Hero anatomical reference',
    )
    actor.face(-20)
    Reflect.set(globalThis, '__heroReference', actor)
  })
  for (const [clip, time] of [
    ['Idle', 0],
    ['Draw', 0.22],
    ['Idle_Gun_Pointing', 0],
    ['Gun_Shoot', 0.09],
    ['TipHat', 0.75],
    ['Walk', 0.25],
    ['Run', 0.2],
    ['Hold_rifle', 0],
    ['Hold_shotgun', 0],
    ['Crouch_Hold_shotgun', 0],
  ] as const) {
    for (const close of [false, true]) {
      const record = await page.evaluate(
        async ({ name, at, portrait }) => {
          const game = (Reflect.get(globalThis, '__ow') as Debug).director.game
          let actor = Reflect.get(globalThis, '__heroReference') as DuelActor
          if (!portrait) {
            actor.destroy()
            const path = '/src/experiments/out-west/duel/native-actor.ts'
            const { DuelActor: NativeActor } = await import(/* @vite-ignore */ path)
            actor = await NativeActor.create(
              game,
              '/experiments/out-west/3d/native-v2/reference/baked/player.glb',
              'Hero anatomical reference',
            )
            actor.face(-20)
            actor.model.anim?.update(1 / 60)
            Reflect.set(globalThis, '__heroReference', actor)
          }
          if (!actor.hasAnimation(name)) {
            throw new Error(`Candidate has no native ${name}`)
          }
          const anim = actor.model.anim
          if (!anim?.baseLayer) {
            throw new Error('Candidate did not create native animation graph')
          }
          anim.playing = true
          actor.play(name, 0)
          anim.baseLayer.activeStateCurrentTime = at
          anim.update(0)
          anim.playing = false
          game.camera.setPosition(
            ...((portrait ? [0.65, 1.65, 1.15] : [2, 1.25, 3.5]) as [number, number, number]),
          )
          game.camera.lookAt(0, portrait ? 1.55 : 0.95, 0)
          if (game.camera.camera) {
            game.camera.camera.fov = portrait ? 25 : 35
          }
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          )
          const instances = actor.root
            .findComponents('render')
            .flatMap((render) => render.meshInstances)
          for (const instance of instances) {
            const skin = instance.skinInstance
            if (!skin?.skin) {
              continue
            }
            for (const [index, bone] of skin.skin.boneNames.entries()) {
              if (skin.bones[index] !== actor.model.findByName(bone)) {
                throw new Error(`Candidate skin is not bound to live ${bone}`)
              }
            }
            if (
              ![...instance.aabb.center.toArray(), ...instance.aabb.halfExtents.toArray()].every(
                Number.isFinite,
              ) ||
              Math.max(...instance.aabb.halfExtents.toArray()) > 3
            ) {
              throw new Error('Candidate skin deformed outside finite human bounds')
            }
          }
          return {
            clip: name,
            time: at,
            close: portrait,
            state: anim.baseLayer.activeState,
            draws: instances.length,
            bones: Object.fromEntries(
              ['Head', 'WristL', 'WristR', 'FootL', 'FootR'].map((bone) => [
                bone,
                actor.model.findByName(bone)?.getPosition().toArray(),
              ]),
            ),
          }
        },
        { name: clip, at: time, portrait: close },
      )
      await page.screenshot({ path: `${output}/${clip}-${close ? 'portrait' : 'body'}.png` })
      records.push(record)
    }
  }
  await writeFile(`${output}/receipt.json`, `${JSON.stringify({ records, errors }, null, 2)}\n`)
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(
    `PASS: ${records.length} native anatomical candidate captures; ${errors.length} page errors`,
  )
} finally {
  await browser.close()
}
