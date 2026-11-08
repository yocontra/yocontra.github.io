/** Actual judged hat shot, native Ammo flight, body retirement and round restoration. */
import { chromium } from 'playwright'

const base = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://127.0.0.1:4390'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/experiments/out-west/#debug&level=1`)
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), null, {
    timeout: 60_000,
  })
  await page.locator('.ow-start').click()
  await page.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'cock')
  await page.keyboard.down('w')
  await page.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'wait')
  await page.keyboard.up('w')
  await page.waitForFunction(
    () => Reflect.get(globalThis, '__ow').director.phase === 'call',
    null,
    { timeout: 30_000 },
  )
  const point = await page.evaluate(() => {
    const d = Reflect.get(globalThis, '__ow').director
    const p = d.enemy.model.findByName('Head').getPosition().clone()
    p.y += 0.12
    const screen = d.game.camera.camera.worldToScreen(p)
    const canvas = d.game.app.graphicsDevice.canvas
    const rect = canvas.getBoundingClientRect()
    return {
      x: rect.left + (screen.x * rect.width) / canvas.width,
      y: rect.top + (screen.y * rect.height) / canvas.height,
    }
  })
  await page.mouse.click(point.x, point.y)
  await page.waitForFunction(() => Reflect.get(globalThis, '__ow').director.phase === 'win')
  const launch = await page.evaluate(() => {
    const d = Reflect.get(globalThis, '__ow').director
    if (!d.hatShot || d.debris.stats().bodies !== 1) {
      throw new Error('Judged pointer hat shot did not detach exactly one native body')
    }
    const piece = d.debris.pieces[0]
    return {
      ...d.debris.stats(),
      y: piece.visual.getPosition().y,
      parent: piece.visual.parent.name,
    }
  })
  await page.waitForFunction(
    (start) =>
      Reflect.get(globalThis, '__ow').director.debris.pieces[0].visual.getPosition().y >
      start + 0.1,
    launch.y,
  )
  await page.screenshot({ path: '/tmp/out-west-native-hat-flight.png' })
  await page.waitForFunction(
    () => Reflect.get(globalThis, '__ow').director.debris.stats().bodies === 0,
  )
  const finish = await page.evaluate(async () => {
    const d = Reflect.get(globalThis, '__ow').director
    const retired = d.debris.stats()
    d.hubShot('hub')
    if (d.debris.stats().pieces !== 0) {
      throw new Error('Hub did not restore detached attachments')
    }
    d.enemy.play('Idle_Gun_Pointing', 0)
    d.enemy.model.anim?.update(0)
    const old = d.enemy
    const away = d.player.root.getPosition().clone().set(0, 0, 1)
    for (let round = 0; round < 3; round++) {
      d.debris.drop(old, 'gun', away)
      if (d.debris.stats().bodies !== 1 || old.muzzle() !== null) {
        throw new Error('Detached gun still fires or lost its native body')
      }
      d.debris.reset()
      if (d.debris.stats().pieces !== 0 || !old.muzzle()) {
        throw new Error('Gun mount failed to restore across repeated rounds')
      }
    }
    await d.startLevel(0)
    d.dispose()
    if (d.debris.stats().pieces !== 0 || d.debris.stats().bodies !== 0) {
      throw new Error('Disposed Duel retained native debris')
    }
    return { retired, reset: d.debris.stats() }
  })
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }
  console.info(JSON.stringify({ launch, finish, errors }))
} finally {
  await browser.close()
}
