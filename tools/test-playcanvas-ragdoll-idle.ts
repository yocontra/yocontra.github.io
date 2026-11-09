/** Real native corpse capture/fall/retirement, with no physics work between captures. */
import { chromium } from 'playwright'

const origin = process.env.OW_ORIGIN ?? 'http://127.0.0.1:4397'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 812, height: 375 } })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/__ragdoll_idle_probe', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }),
  )
  await page.goto(`${origin}/__ragdoll_idle_probe`)
  const result = await page.evaluate(async () => {
    const applicationPath = '/src/experiments/out-west/client/application.ts'
    const actorPath = '/src/experiments/out-west/duel/native-actor.ts'
    const ragdollsPath = '/src/experiments/out-west/client/ragdolls.ts'
    const assetsPath = '/src/experiments/out-west/content/manifest.ts'
    const [{ GameApplication }, { DuelActor }, { NativeRagdolls }, { ASSETS }] = await Promise.all([
      import(applicationPath),
      import(actorPath),
      import(ragdollsPath),
      import(assetsPath),
    ])
    document.body.innerHTML =
      '<div id="view" style="position:fixed;inset:0"><canvas></canvas></div>'
    const game = await GameApplication.create({
      canvas: document.querySelector('canvas'),
      viewport: document.querySelector('#view'),
    })
    game.app.timeScale = 0
    const actor = await DuelActor.create(game, ASSETS.player.url, 'test-rider')
    const ragdolls = await NativeRagdolls.create(game, {
      version: 'ragdoll-idle-floor',
      boxes: [{ center: [0, -0.5, 0], halfExtents: [20, 0.5, 20] }],
      meshes: [],
    })
    const physics = Reflect.get(ragdolls, 'physics')
    const system = physics.app.systems.rigidbody
    const originalStep = system.step
    let steps = 0
    system.step = (dt: number) => {
      steps++
      return originalStep.call(system, dt)
    }
    const stepCount = (): number => steps
    const advance = (frames: number) => {
      for (let frame = 0; frame < frames; frame++) {
        game.app.fire('update', 1 / 60)
        game.app.fire('prerender')
      }
    }
    const resetActor = () => {
      actor.root.setPosition(0, 3, 0)
      actor.play('Idle', 0)
      actor.model.anim?.update(0)
    }
    try {
      advance(120)
      const emptySteps = stepCount()
      if (emptySteps !== 0) {
        throw new Error(`Empty cosmetic world stepped ${steps} times`)
      }
      resetActor()
      const hips = actor.model.findByName('Hips')
      const startY = hips.getPosition().y
      ragdolls.capture('first', actor, actor.root.getPosition().clone().set(0, 0, 0))
      advance(20)
      const fallenY = hips.getPosition().y
      if (stepCount() !== 20 || !(fallenY < startY - 0.1)) {
        throw new Error('New native corpse did not resume stepping and fall')
      }
      advance(300)
      const frozen = ragdolls.stats()
      if (frozen.active !== 0 || frozen.bodies !== 0 || frozen.frozen !== 1) {
        throw new Error('Native corpse did not retire into a frozen pose')
      }
      const retiredSteps = stepCount()
      advance(120)
      if (stepCount() !== retiredSteps) {
        throw new Error('Frozen-only cosmetic world continued stepping')
      }
      ragdolls.release('first')
      resetActor()
      ragdolls.capture('resumed', actor, actor.root.getPosition().clone().set(0, 0, 0))
      advance(1)
      const resumed = ragdolls.stats()
      if (stepCount() !== retiredSteps + 1 || resumed.active !== 1 || resumed.bodies !== 10) {
        throw new Error('Capture after idle did not resume exactly one native step')
      }
      ragdolls.release('resumed')
      const releasedSteps = stepCount()
      advance(120)
      if (stepCount() !== releasedSteps || ragdolls.stats().bodies !== 0) {
        throw new Error('Released corpse retained native stepping')
      }
      ragdolls.destroy()
      advance(2)
      const disposed = ragdolls.stats()
      if (stepCount() !== releasedSteps || system.physicsWorld !== null || disposed.active !== 0) {
        throw new Error('Disposal retained a physics world or update listener')
      }
      return { emptySteps, startY, fallenY, frozen, resumed, disposed, steps: stepCount() }
    } finally {
      ragdolls.destroy()
      actor.destroy()
      game.destroy()
    }
  })
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.log(JSON.stringify({ ...result, errors }))
} finally {
  await browser.close()
}
