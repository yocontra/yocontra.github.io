/** Native close-up review of articulated crow folds and the unchanged ambient clip contract. */
import { mkdir, writeFile } from 'node:fs/promises'
import type { MeshInstance, RenderComponent, StandardMaterial } from 'playcanvas'
import { chromium } from 'playwright'

const origin = process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4389'
const output = process.env.OUT_WEST_OUTPUT ?? '/tmp/out-west-crow-fold/native'
const candidate =
  process.env.OUT_WEST_CROW ?? 'public/experiments/out-west/3d/native-v2/ambient/crow.glb'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const records: unknown[] = []
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.routeWebSocket(`ws://${new URL(origin).host}/**`, (socket) => socket.close())
  await page.route('**/__crow-review.glb', (route) =>
    route.fulfill({ contentType: 'model/gltf-binary', path: candidate }),
  )
  await page.goto(`${origin}/experiments/out-west/#debug&level=1`)
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), null, {
    timeout: 90_000,
  })
  await page.locator('.ow-start').click()
  await page.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'cock')
  await page.locator('.ow-start').waitFor({ state: 'hidden' })
  await page.addStyleTag({
    content:
      '.ow-hud,.ow-cap-call,.ow-cap-fake,.ow-cap-line,astro-dev-toolbar{visibility:hidden!important}',
  })
  await page.evaluate(async () => {
    const d = Reflect.get(globalThis, '__ow').director
    d.paused = true
    d.game.app.timeScale = 0
    d.player.root.enabled = false
    d.enemy.root.enabled = false
    const path = '/src/experiments/out-west/duel/native-actor.ts'
    const { DuelActor } = await import(path)
    const actor = await DuelActor.create(d.game, '/__crow-review.glb', 'Crow fold review')
    Reflect.set(globalThis, '__crowReview', actor)
  })
  for (const clip of ['Idle', 'Fly', 'Gun_Shoot']) {
    for (const time of clip === 'Idle' ? [0, 1, 2] : [0, 0.0833, 0.1667, 0.25, 2]) {
      for (const view of ['side', 'back']) {
        const record = await page.evaluate(
          async ({ clip: name, time: at, view: angle }) => {
            const actor = Reflect.get(globalThis, '__crowReview')
            const game = Reflect.get(globalThis, '__ow').director.game
            if (!actor.hasAnimation(name)) {
              throw new Error(`Missing ${name}`)
            }
            const anim = actor.model.anim
            anim.playing = true
            actor.play(name, 0)
            anim.baseLayer.activeStateCurrentTime = at
            anim.update(0)
            anim.playing = false
            game.camera.setPosition(...(angle === 'side' ? [0.65, 0.27, 0.38] : [0.08, 1.14, 0.08]))
            game.camera.lookAt(0, 0.1, 0)
            game.camera.camera.fov = 35
            game.camera.camera.nearClip = 0.01
            for (let i = 0; i < 3; i++) {
              await new Promise(requestAnimationFrame)
            }
            const meshes = actor.root
              .findComponents('render')
              .flatMap((render: RenderComponent) => render.meshInstances) as MeshInstance[]
            if (meshes.filter((mesh) => mesh.skinInstance && mesh.morphInstance).length !== 2) {
              throw new Error('Expected two skinned wings with fold correctives')
            }
            const bounds = meshes.map((mesh) => {
              const skin = mesh.skinInstance
              if (skin) {
                skin.skin.boneNames.forEach((bone: string, index: number) => {
                  if (skin.bones[index] !== actor.model.findByName(bone)) {
                    throw new Error(`Incorrect live binding ${bone}`)
                  }
                })
              }
              const box = [...mesh.aabb.center.toArray(), ...mesh.aabb.halfExtents.toArray()]
              if (!box.every(Number.isFinite) || Math.max(...mesh.aabb.halfExtents.toArray()) > 1) {
                throw new Error('Invalid crow bounds')
              }
              return { box, normalScale: (mesh.material as StandardMaterial).bumpiness }
            })
            return { clip: name, time: at, view: angle, bounds }
          },
          { clip, time, view },
        )
        records.push(record)
        await page.screenshot({ path: `${output}/${clip}-${time}-${view}.png` })
      }
    }
  }
  for (const [from, to] of [
    ['Idle', 'Fly'],
    ['Fly', 'Idle'],
  ]) {
    for (let step = 0; step <= 8; step++) {
      const transition = await page.evaluate(
        async ({ start, end, frame }) => {
          const actor = Reflect.get(globalThis, '__crowReview')
          const game = Reflect.get(globalThis, '__ow').director.game
          const anim = actor.model.anim
          anim.playing = true
          if (frame === 0) {
            actor.play(start, 0)
            anim.update(0.01)
            actor.play(end, 0.3)
          } else {
            anim.update(0.0375)
          }
          anim.playing = false
          game.camera.setPosition(0.08, 1.14, 0.08)
          game.camera.lookAt(0, 0.1, 0)
          for (let i = 0; i < 3; i++) {
            await new Promise(requestAnimationFrame)
          }
          const weights = actor.root
            .findComponents('render')
            .flatMap((render: RenderComponent) => render.meshInstances)
            .flatMap((mesh: MeshInstance) =>
              mesh.morphInstance ? [mesh.morphInstance.getWeight(0)] : [],
            )
          if (
            weights.length !== 2 ||
            weights.some((weight: number) => !Number.isFinite(weight) || weight < 0 || weight > 1)
          ) {
            throw new Error('Crow fold transition has invalid corrective weights')
          }
          if (
            frame === 8 &&
            weights.some((weight: number) => Math.abs(weight - (end === 'Idle' ? 1 : 0)) > 1e-5)
          ) {
            throw new Error('Crow fold transition did not reach its authored endpoint')
          }
          return { from: start, to: end, time: frame * 0.0375, weights }
        },
        { start: from, end: to, frame: step },
      )
      records.push(transition)
      await page.screenshot({ path: `${output}/${from}-to-${to}-${step}.png` })
    }
  }
  await page.evaluate(async () => {
    const actor = Reflect.get(globalThis, '__crowReview')
    const game = Reflect.get(globalThis, '__ow').director.game
    const root = actor.root
    actor.destroy()
    game.releaseContainer('/__crow-review.glb')
    await new Promise(requestAnimationFrame)
    if (
      root.parent ||
      game.app.assets
        .list()
        .some((asset: { file?: { url?: string } }) =>
          asset.file?.url?.includes('__crow-review.glb'),
        )
    ) {
      throw new Error('Crow review retained its native actor or container')
    }
  })
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  await writeFile(`${output}/receipt.json`, JSON.stringify({ candidate, records, errors }, null, 2))
} finally {
  await browser.close()
}
