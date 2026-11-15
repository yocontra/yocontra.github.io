/** Inspect the isolated anatomical candidate in the actual mounted native duel renderer. */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { chromium } from 'playwright'
import type { GameApplication } from '../src/experiments/out-west/client/application.ts'
import type { DuelActor } from '../src/experiments/out-west/duel/native-actor.ts'

const base = process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4397'
const output = process.env.OUT_WEST_OUTPUT ?? '/tmp/out-west-hero-native'
const staging = resolve(process.env.OUT_WEST_HERO_CONTENT ?? '/tmp/out-west-hero-content')
const sourceUrl =
  process.env.OUT_WEST_HERO_URL ?? '/experiments/out-west/3d/native-v2/reference/baked/player.glb'
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
  await page.route('**/experiments/out-west/3d/native-v2/**', async (route) => {
    const prefix = '/experiments/out-west/3d/native-v2/'
    const file = resolve(staging, new URL(route.request().url()).pathname.split(prefix)[1] ?? '')
    if (
      file.startsWith(`${staging}/`) &&
      (await stat(file).then(
        (entry) => entry.isFile(),
        () => false,
      ))
    ) {
      const mime: Record<string, string> = {
        '.glb': 'model/gltf-binary',
        '.webp': 'image/webp',
        '.ktx2': 'image/ktx2',
      }
      await route.fulfill({
        path: file,
        contentType: mime[extname(file)] ?? 'application/octet-stream',
      })
    } else {
      await route.continue()
    }
  })
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
  await page.evaluate(() => {
    const d = (Reflect.get(globalThis, '__ow') as Debug).director
    d.paused = true
    d.game.app.timeScale = 0
    d.player.root.enabled = false
    d.enemy.root.enabled = false
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
    ['Shoot_rifle', 0.1],
    ['Hold_shotgun', 0],
    ['Shoot_shotgun', 0.1],
    ['Crouch_Hold_shotgun', 0],
  ] as const) {
    if (process.env.OUT_WEST_HERO_CLIP && process.env.OUT_WEST_HERO_CLIP !== clip) {
      continue
    }
    await page.evaluate(
      async ({ name, at, url }) => {
        const game = (Reflect.get(globalThis, '__ow') as Debug).director.game
        ;(Reflect.get(globalThis, '__heroReference') as DuelActor | undefined)?.destroy()
        const path = '/src/experiments/out-west/duel/native-actor.ts'
        const { DuelActor: NativeActor } = await import(/* @vite-ignore */ path)
        const actor: DuelActor = await NativeActor.create(game, url, 'Hero anatomical reference')
        actor.face(-20)
        actor.paired = false
        actor.batchRigid = false
        let weapon: 'revolver' | 'rifle' | 'shotgun' = 'revolver'
        if (name.includes('shotgun')) {
          weapon = 'shotgun'
        } else if (name.includes('rifle')) {
          weapon = 'rifle'
        }
        if (weapon !== 'revolver') {
          const equipment = '/src/experiments/out-west/scene/native-equipment.ts'
          const { attachHeldWeapon } = await import(/* @vite-ignore */ equipment)
          await attachHeldWeapon(
            game,
            actor,
            weapon,
            `/experiments/out-west/3d/native-v2/dynamic/held-${weapon}.glb`,
          )
        }
        actor.hold(weapon, weapon !== 'revolver')
        actor.model.anim?.update(1 / 60)
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
        Reflect.set(globalThis, '__heroReference', actor)
      },
      { name: clip, at: time, url: sourceUrl },
    )
    for (const view of ['body', 'portrait', 'hands'] as const) {
      const record = await page.evaluate(
        async ({ name, at, selectedView }) => {
          const game = (Reflect.get(globalThis, '__ow') as Debug).director.game
          const actor = Reflect.get(globalThis, '__heroReference') as DuelActor
          const portrait = selectedView === 'portrait'
          game.camera.setPosition(
            ...((portrait ? [0.65, 1.65, 1.15] : [2, 1.25, 3.5]) as [number, number, number]),
          )
          game.camera.lookAt(0, portrait ? 1.55 : 0.95, 0)
          if (selectedView === 'hands') {
            const hand = actor.model.findByName('WristR')?.getPosition()
            if (hand) {
              game.camera.setPosition(hand.x + 0.45, hand.y + 0.18, hand.z + 0.65)
              game.camera.lookAt(hand.x, hand.y + 0.03, hand.z)
            }
          }
          if (game.camera.camera) {
            game.camera.camera.fov = portrait ? 25 : 35
          }
          await new Promise<void>((complete) =>
            requestAnimationFrame(() => requestAnimationFrame(() => complete())),
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
            view: selectedView,
            state: actor.model.anim?.baseLayer?.activeState,
            draws: instances.length,
            bones: Object.fromEntries(
              ['Head', 'WristL', 'WristR', 'FootL', 'FootR'].map((bone) => [
                bone,
                actor.model.findByName(bone)?.getPosition().toArray(),
              ]),
            ),
          }
        },
        { name: clip, at: time, selectedView: view },
      )
      await page.screenshot({ path: `${output}/${clip}-${view}.png` })
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
