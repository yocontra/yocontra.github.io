/** Actual native game-page first-person rig/world eye alignment and visible weapon classes. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import type { FrontierSession } from '../src/experiments/out-west/client/frontier-session.ts'
import type { GameViewport } from '../src/experiments/out-west/client/viewport.ts'

const origin = process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4390'
const output = '/tmp/out-west-character-first-person-final'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
const results: unknown[] = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  await page.routeWebSocket(
    (url) => url.origin === 'ws://127.0.0.1:4390',
    () => undefined,
  )
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=0&seed=7&spawn=72,66`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => Boolean(Reflect.get(globalThis, '__playcanvasFrontier')),
    undefined,
    { timeout: 90_000 },
  )
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).firstPerson(true),
  )
  for (const [name, weapon] of [
    ['revolver', 0],
    ['shotgun', 1],
    ['rifle', 2],
  ] as const) {
    await page.evaluate((kind) => {
      const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
      const self = session.world.players[session.selfSlot]
      if (!self) {
        throw new Error('Missing self')
      }
      self.weapon = kind
      self.weaponRounds = 8
      self.ammo = 6
    }, weapon)
    for (const crouched of [false, true]) {
      if (crouched) {
        await page.keyboard.down('KeyC')
      } else {
        await page.keyboard.up('KeyC')
      }
      await page.waitForFunction((expected) => {
        const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
        return session.world.players[session.selfSlot]?.crouched === expected
      }, crouched)
      // Native clip transitions and held-container loads must settle before measuring the authored pivot.
      const result = await page.evaluate(async () => {
        const path = '/tools/content/actor-lifecycle-probe.ts'
        const probe = await import(path)
        const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
        for (let frame = 0; frame < 30; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
        return probe.riderView(session.selfId)
      })
      const r = result as {
        eye: { x: number; y: number; z: number }
        rigEye: { x: number; y: number; z: number }
        muzzle?: { x: number; y: number; z: number }
        muzzleForward?: { x: number; y: number; z: number }
        forward: { x: number; y: number; z: number }
      }
      const error = Math.hypot(r.eye.x - r.rigEye.x, r.eye.y - r.rigEye.y, r.eye.z - r.rigEye.z)
      if (error > 0.03 || !r.muzzle) {
        throw new Error(`FP ${name} crouch${crouched} rig offset${error}:${JSON.stringify(result)}`)
      }
      const dot = r.muzzleForward
        ? r.forward.x * r.muzzleForward.x +
          r.forward.y * r.muzzleForward.y +
          r.forward.z * r.muzzleForward.z
        : 0
      if (dot < 0.95) {
        throw new Error(`FP ${name} barrel faces away:${dot}`)
      }
      results.push({ name, crouched, error, dot, pose: result })
      await page.screenshot({ path: `${output}/${name}-${crouched ? 'crouched' : 'standing'}.png` })
      await page.waitForFunction(() => {
        const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
        const self = session.world.players[session.selfSlot]
        return self && self.fireCooldownMs <= 0 && self.reloadTicks === 0
      })
      const shot = await page.evaluate(async (expectedWeapon) => {
        const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
        const self = session.world.players[session.selfSlot]
        if (!self || self.weapon !== expectedWeapon) {
          throw new Error('First-person fixture did not equip requested weapon')
        }
        const before = self.lastFireTick
        const path = '/tools/content/actor-lifecycle-probe.ts'
        const probe = await import(path)
        ;(Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).tap(1)
        for (let frame = 0; frame < 30; frame++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          const pose = probe.riderView(session.selfId) as {
            controllers: { state?: string; time?: number }[]
          }
          if (
            self.lastFireTick > before &&
            pose.controllers.some(
              (controller) => controller.state?.includes('Shoot') && (controller.time ?? 0) > 0,
            )
          ) {
            return { weapon: self.weapon, fireTick: self.lastFireTick, pose }
          }
        }
        throw new Error('First-person input did not produce a real shot/native recoil')
      }, weapon)
      results.push({ name, crouched, shot })
      await page.screenshot({
        path: `${output}/${name}-${crouched ? 'crouched' : 'standing'}-shot.png`,
      })
    }
  }
  await page.keyboard.up('KeyC')
  if (errors.length > 0) {
    throw new Error(errors.join(';'))
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ results, errors }, null, 2))
  console.log(
    'PASS actual first-person native standing/crouch three weapons',
    JSON.stringify(results),
  )
} finally {
  await browser.close()
}
