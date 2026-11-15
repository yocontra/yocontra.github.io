/** Actual native game-page first-person arms: physical eye, sights, shots, shadows and lifecycle. */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, type Page } from 'playwright'
import type { FrontierSession } from '../src/experiments/out-west/client/frontier-session.ts'
import type { GameViewport } from '../src/experiments/out-west/client/viewport.ts'
import { HOLSTER_TICKS } from '../src/experiments/out-west/ffa/sim/constants.ts'

const origin = process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4390'
const output = process.env.OUT_WEST_OUTPUT ?? '/tmp/out-west-character-first-person-final'
const portrait = process.env.OUT_WEST_ORIENTATION === 'portrait'
const probePath = '/tools/content/actor-lifecycle-probe.ts'
const sightsPath = '/src/experiments/out-west/client/first-person-sights.ts'
const posePath = '/src/experiments/out-west/client/player-pose.ts'
const deathPath = '/src/experiments/out-west/ffa/sim/death.ts'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors: string[] = []
const results: Record<string, unknown>[] = []

interface View {
  eye: { x: number; y: number; z: number }
  physicalEye: { x: number; y: number; z: number }
  fov: number
  world: {
    instances: number
    forwardHidden: number
    castShadows: number
    controllers: { state?: string; time?: number }[]
  }
  arms: {
    total: number
    visible: number
    instances: number
    onLayer: boolean
    castShadows: number
    drawnGuns: number
    front?: { x: number; y: number; z: number }
    rear?: { x: number; y: number; z: number }
    controllers: { node: string; state?: string; time?: number }[]
  }
  layer: { clearDepth: boolean; onCamera: boolean } | null
  textures: number
  buffers: number
  assets: number
  center: { x: number; y: number }
}

function check(condition: boolean, message: string, detail?: unknown): void {
  if (!condition) {
    throw new Error(`${message}: ${JSON.stringify(detail)}`)
  }
}

async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    for (let frame = 0; frame < n; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }, count)
}

async function view(page: Page, weapon?: string): Promise<View> {
  return (await page.evaluate(
    async (paths) => {
      const probe = await import(paths.probe)
      const { SIGHTS } = await import(paths.sights)
      const pose = await import(paths.pose)
      const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
      const profile = paths.weapon ? SIGHTS.get(paths.weapon) : undefined
      const result = probe.firstPersonView(
        session.selfId,
        profile ? { front: profile.front.toArray(), rear: profile.rear.toArray() } : undefined,
      )
      const self = session.players.get(session.selfId)
      return {
        ...result,
        physicalEye: self ? pose.poseEye(self) : null,
        center: { x: innerWidth / 2, y: innerHeight / 2 },
      }
    },
    { probe: probePath, sights: sightsPath, pose: posePath, weapon },
  )) as View
}

function eyeError(v: View): number {
  return Math.hypot(v.eye.x - v.physicalEye.x, v.eye.y - v.physicalEye.y, v.eye.z - v.physicalEye.z)
}

function presented(v: View, label: string): void {
  check(eyeError(v) <= 1e-6, `${label} physical camera eye moved`, v)
  check(v.arms.visible === 1 && v.arms.total <= 2, `${label} arms actor count`, v.arms)
  check(v.arms.onLayer && v.arms.castShadows === 0, `${label} arms layer/shadow`, v.arms)
  check(
    v.world.forwardHidden === v.world.instances && v.world.instances > 0,
    `${label} world body forward color still drawn`,
    v.world,
  )
  check(v.world.castShadows > 0, `${label} world body lost its shadow`, v.world)
  check(Boolean(v.layer?.clearDepth && v.layer.onCamera), `${label} viewmodel layer`, v.layer)
}

async function equip(page: Page, kind: number): Promise<void> {
  await page.evaluate((weapon) => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const self = session.world.players[session.selfSlot]
    if (!self) {
      throw new Error('Missing self')
    }
    self.weapon = weapon
    self.weaponRounds = 8
    self.ammo = 6
  }, kind)
}

async function shoot(page: Page, label: string): Promise<Record<string, unknown>> {
  await page.waitForFunction(() => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const self = session.world.players[session.selfSlot]
    return self && self.fireCooldownMs <= 0 && self.reloadTicks === 0
  })
  const before = await page.evaluate(() => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const tick = session.world.players[session.selfSlot]?.lastFireTick ?? -1
    ;(Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).tap(1)
    return tick
  })
  let longest = 0
  let started = false
  let worstEye = 0
  for (let frame = 0; frame < 40; frame++) {
    await frames(page, 1)
    const v = await view(page)
    worstEye = Math.max(worstEye, eyeError(v))
    const arms = v.arms.controllers.find((c) => c.state?.includes('Shoot'))
    if (arms) {
      started = true
      longest = Math.max(longest, arms.time ?? 0)
    } else if (started) {
      break
    }
  }
  const fired = await page.evaluate((tick) => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    return (session.world.players[session.selfSlot]?.lastFireTick ?? -1) > tick
  }, before)
  check(fired && started, `${label} did not produce a real shot on the arms`, { fired, started })
  check(longest >= 0.18, `${label} arms shot clock was cut short`, longest)
  check(worstEye <= 1e-6, `${label} physical eye moved while firing`, worstEye)
  return { longest, worstEye }
}

async function deadEyeFeedback(page: Page): Promise<void> {
  await page.waitForFunction((holsterTicks) => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const self = session.world.players[session.selfSlot]
    return self && self.reloadTicks === 0 && session.world.tick - self.lastFireTick >= holsterTicks
  }, HOLSTER_TICKS)
  await page.mouse.down({ button: 'right' })
  const feedback = await page.evaluate(async () => {
    let charging = false
    let ready = false
    const start = performance.now()
    while (performance.now() - start < 1000) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const reticle = document.querySelector<HTMLElement>('.fr-reticle')
      const close = Number(reticle?.style.getPropertyValue('--close'))
      charging ||= Boolean(reticle?.classList.contains('dead-eye') && close > 0 && close < 1)
      ready ||= Boolean(reticle?.classList.contains('ready') && close === 1)
    }
    return { charging, ready }
  })
  check(feedback.charging && feedback.ready, 'Dead-Eye charge and ready ring survive ADS', feedback)
  await page.screenshot({ path: `${output}/dead-eye-aimed.png` })
  await page.mouse.up({ button: 'right' })
  await frames(page, 5)
  check(
    (await page.locator('.fr-reticle.dead-eye').count()) === 0,
    'Dead-Eye ring clears when aim is released',
  )
  results.push({ deadEye: feedback })
}

try {
  const viewport = portrait ? { width: 375, height: 812 } : { width: 1280, height: 720 }
  const page = await browser.newPage({ viewport })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(
    `${origin}/experiments/out-west/frontier/?server=loopback&bots=0&seed=7&spawn=72,66`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () =>
      Boolean(
        Reflect.get(globalThis, '__nativeFrontierSession') &&
          Reflect.get(globalThis, '__playcanvasFrontier'),
      ),
    undefined,
    { timeout: 120_000 },
  )
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).firstPerson(true),
  )
  await frames(page, 30)
  // Death restores the world color pass for the ragdoll; the new life presents arms again.
  await page.evaluate(async (path) => {
    const death = await import(path)
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const self = session.world.players[session.selfSlot]
    if (self) {
      death.killPlayer(session.world, self, 255)
    }
  }, deathPath)
  let dead: View | undefined
  const trace: unknown[] = []
  for (let attempt = 0; attempt < 120 && !dead; attempt++) {
    await frames(page, 1)
    const v = await view(page)
    trace.push({
      arms: v.arms.visible,
      hidden: v.world.forwardHidden,
    })
    if (v.arms.visible === 0) {
      dead = v
    }
  }
  check(Boolean(dead) && dead?.world.forwardHidden === 0, 'death restores world body', {
    dead,
    trace: trace.slice(0, 8),
  })
  await page.waitForFunction(
    () => {
      const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
      return (session.players.get(session.selfId)?.hp ?? 0) > 0
    },
    undefined,
    { timeout: 30_000 },
  )
  await frames(page, 20)
  presented(await view(page), 'respawned')
  await page.mouse.move(viewport.width / 2, viewport.height / 2)
  for (const [name, kind] of [
    ['revolver', 0],
    ['shotgun', 1],
    ['rifle', 2],
  ] as const) {
    await equip(page, kind)
    for (const crouched of [false, true]) {
      const label = `${name}-${crouched ? 'crouched' : 'standing'}`
      if (crouched) {
        await page.keyboard.down('KeyC')
      } else {
        await page.keyboard.up('KeyC')
      }
      await page.waitForFunction((expected) => {
        const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
        return session.world.players[session.selfSlot]?.crouched === expected
      }, crouched)
      await frames(page, 30)
      const hip = await view(page)
      presented(hip, `${label} hip`)
      await page.screenshot({ path: `${output}/${label}-hip.png` })
      await page.mouse.down({ button: 'right' })
      await frames(page, 40)
      const aimed = await view(page, name)
      presented(aimed, `${label} sights`)
      check(aimed.fov < hip.fov, `${label} sights did not engage`, {
        hip: hip.fov,
        aimed: aimed.fov,
      })
      for (const landmark of [aimed.arms.front, aimed.arms.rear]) {
        check(
          Boolean(landmark) &&
            Math.hypot((landmark?.x ?? 0) - aimed.center.x, (landmark?.y ?? 0) - aimed.center.y) <=
              1.5,
          `${label} sight landmark off the reticle`,
          { landmark, center: aimed.center },
        )
      }
      await page.screenshot({ path: `${output}/${label}-sights.png` })
      const shot = await shoot(page, `${label} sights`)
      await page.screenshot({ path: `${output}/${label}-sights-shot.png` })
      await page.mouse.up({ button: 'right' })
      await frames(page, 20)
      const hipShot = await shoot(page, `${label} hip`)
      results.push({
        label,
        hipFov: hip.fov,
        sightFov: aimed.fov,
        front: aimed.arms.front,
        rear: aimed.arms.rear,
        shot,
        hipShot,
      })
    }
  }
  await page.keyboard.up('KeyC')
  await equip(page, 0)
  await frames(page, 20)
  await deadEyeFeedback(page)

  // Third person restores the exact world color pass; returning masks it again.
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).firstPerson(false),
  )
  await frames(page, 5)
  const third = await view(page)
  check(third.world.forwardHidden === 0 && third.arms.visible === 0, 'third person', third)
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).firstPerson(true),
  )
  await frames(page, 5)
  presented(await view(page), 'returned to first person')

  // Repeated outfit/gun swaps keep one active plus at most one pending actor and release leases.
  const counts: { textures: number; buffers: number; assets: number }[] = []
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const [outfit, gun, drawn] of [
      ['outfit.wool-duster', 'gun.hardins-pair', 2],
      ['outfit.trail-duds', 'gun.rusty-six', 1],
    ] as const) {
      await page.evaluate(
        (next) => {
          const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
          const self = session.selfId
          const loadout = {
            outfit: next.outfit,
            gun: next.gun,
            hat: 'hat.plainsman',
            spurs: 'spurs.plain-rowels',
            holster: 'holster.plain-leather',
            extra: null,
          }
          Reflect.set(session, 'appearance', (id: string) =>
            id === self
              ? { loadout, dyes: {}, key: `${next.outfit}:${next.gun}:${next.cycle}` }
              : undefined,
          )
        },
        { outfit, gun, cycle },
      )
      let swapped: View | undefined
      for (let attempt = 0; attempt < 600; attempt++) {
        await frames(page, 1)
        const v = await view(page)
        check(v.arms.total <= 2 && v.arms.visible <= 1, 'swap actor bound', v.arms)
        if (v.arms.visible === 1 && v.arms.total === 1 && v.arms.drawnGuns === drawn) {
          const settled = await page.evaluate(
            () =>
              (
                Reflect.get(globalThis, '__frontier') as () => {
                  actors: { loading: number; viewmodel: { pending: number } }
                }
              )().actors,
          )
          if (settled.loading === 0 && settled.viewmodel.pending === 0) {
            swapped = v
            break
          }
        }
      }
      check(Boolean(swapped), `swap to ${outfit} ${gun} never settled`)
      await frames(page, 10)
      presented(await view(page), `swap ${outfit}`)
      if (cycle === 0) {
        await page.screenshot({ path: `${output}/swap-${outfit}.png` })
      }
    }
    const settled = await view(page)
    counts.push({ textures: settled.textures, buffers: settled.buffers, assets: settled.assets })
  }
  check(
    counts.every(
      (count) =>
        count.textures <= (counts[0]?.textures ?? 0) &&
        count.buffers <= (counts[0]?.buffers ?? 0) &&
        count.assets <= (counts[0]?.assets ?? 0),
    ),
    'repeated swaps leaked textures or assets',
    counts,
  )
  results.push({ swapCounts: counts })

  if (errors.length > 0) {
    throw new Error(errors.join(';'))
  }
  await writeFile(`${output}/results.json`, JSON.stringify({ results, errors }, null, 2))
  console.log('PASS native first-person arms', JSON.stringify(results))
} finally {
  await browser.close()
}
