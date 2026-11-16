/** Native title/cues/kill-frame/boss-drop regression; writes reviewable game renders. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:4396'
const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-duel-presentation'
await mkdir(output)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
const ALIGNMENT =
  /^ASSERT FAILED: {2}Non-interleaved vertex format with element size not multiple of 4 can have performance impact on some platforms\. Element size: [36]$/u
const diagnostics: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !ALIGNMENT.test(message.text())) {
      errors.push(message.text())
    } else if (message.type() === 'error') {
      diagnostics.push(message.text())
    }
  })
  await page.goto(`${base}/experiments/out-west/#debug&level=1`)
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), null, {
    timeout: 60_000,
  })
  await page.locator('.ow-start').click()
  await page.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'cock')
  await page.locator('.ow-start').waitFor({ state: 'hidden' })
  const title = await page.evaluate(() => {
    const d = Reflect.get(globalThis, '__ow').director
    d.enter('title')
    d.paused = true
    d.hubShot('hub')
    const high = d.rig.pose().pos.toArray()
    d.rig.update(6.5)
    const low = d.rig.pose().pos.toArray()
    d.rig.update(7.5)
    const loop = d.rig.pose().pos.toArray()
    if (high[1] !== 19 || low[1] !== 2 || loop[1] !== 19) {
      throw new Error('Title crane lost its original high/low/loop framing')
    }
    d.rig.update(6.5)
    return { high, low, loop }
  })
  await page.screenshot({ path: `${output}/title.png` })
  const cues = await page.evaluate(async () => {
    const d = Reflect.get(globalThis, '__ow').director
    d.paused = false
    await d.startLevel(0)
    d.paused = true
    d.remotePace(6)
    d.wait()
    const captions: string[] = []
    const original = d.c.hud.fake.bind(d.c.hud)
    d.c.hud.fake = (text: string) => {
      captions.push(text)
      original(text)
    }
    const before = d.atmosphere.folk.map(
      (folk: { actor: { model: { anim: { baseLayer: { activeState: string } } } } }) =>
        folk.actor.model.anim.baseLayer.activeState,
    )
    for (const cue of [
      'crow',
      'dog',
      'horse',
      'coin',
      'bottle',
      'twitch',
      'whistle',
      'lantern',
      'piano-stop',
      'gang-drr',
      'cards',
    ]) {
      d.cue(cue)
    }
    const after = d.atmosphere.folk.map(
      (folk: { actor: { model: { anim: { baseLayer: { activeState: string } } } } }) =>
        folk.actor.model.anim.baseLayer.activeState,
    )
    d.c.hud.fake = original
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Fake-outs interrupted spectator clips')
    }
    if (
      !(
        captions.includes('[a crow caws]') &&
        captions.includes('[cards scatter]') &&
        captions.includes('[the piano stops]')
      )
    ) {
      throw new Error('Authored fake-out captions missing')
    }
    return { captions, spectators: before.length }
  })
  const kill = await page.evaluate(async () => {
    const d = Reflect.get(globalThis, '__ow').director
    const path = '/src/experiments/out-west/duel/native-moments.ts'
    const { killFrame } = await import(/* @vite-ignore */ path)
    const scene = d.game.app.scene
    const lens = d.game.camera.camera
    const clear = lens.clearColor.toString()
    const layers = [...lens.layers]
    const ambient = scene.ambientLight.toString()
    const light = scene.skyboxIntensity
    killFrame(d, true)
    const active = {
      clear: lens.clearColor.toString(),
      ambient: scene.ambientLight.toString(),
      sky: scene.skyboxIntensity,
    }
    if (active.ambient !== '#000000' || active.sky !== 0 || active.clear !== '#ff0000') {
      throw new Error(`Kill frame did not silence native illumination: ${JSON.stringify(active)}`)
    }
    return { active, clear, layers, ambient, light }
  })
  await page.screenshot({ path: `${output}/kill-frame.png` })
  await page.evaluate(async (before) => {
    const d = Reflect.get(globalThis, '__ow').director
    const path = '/src/experiments/out-west/duel/native-moments.ts'
    const { killFrame } = await import(/* @vite-ignore */ path)
    killFrame(d, false)
    const scene = d.game.app.scene
    const lens = d.game.camera.camera
    if (
      lens.clearColor.toString() !== before.clear ||
      scene.ambientLight.toString() !== before.ambient ||
      scene.skyboxIntensity !== before.light ||
      JSON.stringify(lens.layers) !== JSON.stringify(before.layers)
    ) {
      throw new Error('Kill frame did not restore native scene state')
    }
  }, kill)
  const underboss = await page.evaluate(async () => {
    const d = Reflect.get(globalThis, '__ow').director
    await d.startLevel(15)
    d.paused = true
    d.remotePace(6)
    d.wait()
    d.call()
    const fire = (ms: number) =>
      d.shoot({ action: 'fire', t: d.callTime + ms, source: 'key', x: -1, y: -1 })
    fire(200)
    if (d.riflemanAlive || !d.enemyAlive || d.phase !== 'call') {
      throw new Error('Underboss first shot did not target the rifleman alone')
    }
    fire(250)
    if (d.shots !== 1) {
      throw new Error('Underboss second-target gap was bypassed')
    }
    fire(310)
    if (d.phase !== 'win' || d.enemyAlive || d.riflemanAlive || d.shots !== 2) {
      throw new Error('Underboss second shot did not finish the duel')
    }
    const path = '/src/experiments/out-west/duel/native-outcome.ts'
    const { startKillCam } = await import(/* @vite-ignore */ path)
    startKillCam(d)
    d.rig.update(0)
    return { shots: d.shots, phase: d.phase, reaction: d.reactionMs }
  })
  await page.screenshot({ path: `${output}/underboss-win.png` })
  const boss = await page.evaluate(async () => {
    const d = Reflect.get(globalThis, '__ow').director
    await d.startLevel(16)
    await d.debris.ready
    d.paused = true
    d.enter('call')
    d.enemy.play('Idle_Gun_Pointing', 0)
    const left = d.enemy.weaponMounts.find(
      (mount: { drawn: boolean; hand: string }) => mount.drawn && mount.hand === 'L',
    )
    const right = d.enemy.weaponMounts.find(
      (mount: { drawn: boolean; hand: string }) => mount.drawn && mount.hand === 'R',
    )
    if (!(left?.node.enabled && right?.node.enabled)) {
      throw new Error('Boss does not start with two drawn guns')
    }
    const leftParent = left.node.parent
    const rightParent = right.node.parent
    d.resolve('win', 200)
    const path = '/src/experiments/out-west/duel/native-outcome.ts'
    const { tickBossWound } = await import(/* @vite-ignore */ path)
    d.phaseT = 0.08
    tickBossWound(d)
    if (
      left.node.parent === leftParent ||
      right.node.parent !== rightParent ||
      d.debris.stats().pieces !== 1
    ) {
      throw new Error('Boss wound must drop only his left-hand gun')
    }
    tickBossWound(d)
    if (d.debris.stats().pieces !== 1) {
      throw new Error('Repeated wound tick duplicated debris')
    }
    const start = left.node.getPosition().toArray()
    for (let i = 0; i < 30; i++) {
      d.debris.update(1 / 60)
      d.enemy.model.anim.update(1 / 60)
      d.player.model.anim.update(1 / 60)
    }
    const flying = left.node.getPosition().toArray()
    if (JSON.stringify(start) === JSON.stringify(flying)) {
      throw new Error('Boss dropped gun does not move')
    }
    d.phaseT = 2.41
    tickBossWound(d)
    const leftHolster = d.enemy.weaponMounts.find(
      (mount: { drawn: boolean; hand: string }) => !mount.drawn && mount.hand === 'L',
    )
    if (leftHolster?.node.enabled) {
      throw new Error('Boss duplicated his dropped gun in the left holster')
    }
    d.enemy.play('Draw', 0)
    if (left.node.parent === leftParent || right.node.parent !== rightParent) {
      throw new Error('Boss second draw reattached the dropped weapon')
    }
    d.enter('lose')
    d.retry()
    if (
      left.node.parent === leftParent ||
      d.debris.stats().pieces !== 1 ||
      leftHolster?.node.enabled
    ) {
      throw new Error('Boss phase-two retry restored his discarded gun')
    }
    const eye = d.enemy.root.getPosition()
    d.game.camera.setPosition(eye.x + 2, 1.4, eye.z - 3)
    d.game.camera.lookAt(eye.x, 1, eye.z)
    return { start, flying, phase: d.phase, bossPhase: d.bossPhase, debris: d.debris.stats() }
  })
  await page.screenshot({ path: `${output}/boss-second-phase.png` })
  await page.evaluate(() => {
    const d = Reflect.get(globalThis, '__ow').director
    d.hubShot('hub')
    if (d.debris.stats().pieces !== 0) {
      throw new Error('Returning home leaked boss debris')
    }
  })
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  const receipt = { title, cues, kill, underboss, boss, errors, diagnostics }
  await writeFile(`${output}/receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(JSON.stringify(receipt, null, 2))
} finally {
  await browser.close()
}
