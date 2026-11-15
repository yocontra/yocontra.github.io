/** Actual decoded-GLB cancellation and disposal against the mounted native first-person actor. */
import type { Page } from 'playwright'
import type { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import type { FrontierSession } from '../../src/experiments/out-west/client/frontier-session.ts'
import type { GameViewport } from '../../src/experiments/out-west/client/viewport.ts'
import type { ShotRay } from '../../src/experiments/out-west/ffa/sim/combat.ts'

function check(condition: boolean, message: string, detail: unknown): void {
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

interface NativeGate {
  release: () => void
}
interface LifecycleGate {
  game?: GameApplication
  device?: GameApplication['app']['graphicsDevice']
  gates: NativeGate[]
  restore: () => void
  appearance: (key: string) => void
}

async function waitForGate(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      (Reflect.get(globalThis, '__fpLifecycleGate') as LifecycleGate).gates.length === expected,
    count,
  )
}
async function releaseGate(page: Page, index: number): Promise<void> {
  await page.evaluate(
    (entry) =>
      (Reflect.get(globalThis, '__fpLifecycleGate') as LifecycleGate).gates[entry]?.release(),
    index,
  )
}
async function waitForNoPending(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug().actors.viewmodel
        .pending === 0,
  )
}

async function cancelLifeAndView<
  T extends { actors: number; visible: number; roots: number; gates: number },
>(page: Page, inspect: () => Promise<T>): Promise<Record<string, T>> {
  // A new life must not inherit a completed actor from the dead request.
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__fpLifecycleGate') as LifecycleGate).appearance('dead-pending'),
  )
  await waitForGate(page, 3)
  await page.evaluate(async () => {
    const path = '/src/experiments/out-west/ffa/sim/death.ts'
    const { killPlayer } = await import(path)
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const self = session.world.players[session.selfSlot]
    if (!self) {
      throw new Error('Missing self during death cancellation')
    }
    killPlayer(session.world, self, 255)
    self.respawnTick = session.world.tick + 10_000
  })
  await frames(page, 5)
  const dead = await inspect()
  check(
    dead.actors === 1 && dead.visible === 0 && dead.roots === 1,
    'death retained pending arms',
    dead,
  )
  await releaseGate(page, 2)
  await waitForNoPending(page)
  const deadResolved = await inspect()
  check(
    deadResolved.gates === 3 && deadResolved.visible === 0,
    'dead request rebuilt or presented late arms',
    deadResolved,
  )
  await page.evaluate(async () => {
    const path = '/src/experiments/out-west/ffa/sim/world.ts'
    const { spawnPlayer } = await import(path)
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const self = session.world.players[session.selfSlot]
    if (self) {
      spawnPlayer(session.world, self)
    }
  })
  await waitForGate(page, 4)
  await releaseGate(page, 3)
  await waitForNoPending(page)
  await frames(page, 5)
  const respawned = await inspect()
  check(
    respawned.actors === 1 && respawned.visible === 1 && respawned.roots === 1,
    'new life did not present clean arms',
    respawned,
  )
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__fpLifecycleGate') as LifecycleGate).appearance('view-pending'),
  )
  await waitForGate(page, 5)
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).firstPerson(false),
  )
  await frames(page, 5)
  const third = await inspect()
  check(
    third.actors === 1 && third.visible === 0 && third.roots === 1,
    'view exit retained pending arms',
    third,
  )
  await releaseGate(page, 4)
  await waitForNoPending(page)
  await page.evaluate(() =>
    (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).firstPerson(true),
  )
  await waitForGate(page, 6)
  await releaseGate(page, 5)
  await waitForNoPending(page)
  await frames(page, 5)
  const returned = await inspect()
  check(
    returned.actors === 1 && returned.visible === 1 && returned.roots === 1,
    'view return did not present clean arms',
    returned,
  )
  return { dead, deadResolved, respawned, third, returned }
}

/** Gate actual decoded held-weapon GLBs; no replacement of meshes, textures or controllers. */
export async function delayedNativeLifecycle(
  page: Page,
  output: string,
): Promise<Record<string, unknown>> {
  await page.evaluate(async () => {
    const path = '/src/experiments/out-west/client/application.ts'
    const { GameApplication: NativeApplication } = await import(path)
    const original: GameApplication['loadContainer'] = NativeApplication.prototype.loadContainer
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const prior = session.appearance
    const gate: LifecycleGate = {
      gates: [],
      restore: () => {
        NativeApplication.prototype.loadContainer = original
        Reflect.set(session, 'appearance', prior)
      },
      appearance: (key) => {
        Reflect.set(session, 'appearance', (id: string) => {
          const old = prior?.(id)
          return id === session.selfId && old ? { ...old, key } : old
        })
      },
    }
    NativeApplication.prototype.loadContainer = async function (
      this: GameApplication,
      url: string,
    ) {
      const asset = await original.call(this, url)
      if (url.includes('/held-shotgun.glb')) {
        gate.game = this
        gate.device = this.app.graphicsDevice
        await new Promise<void>((release) => gate.gates.push({ release }))
      }
      return asset
    }
    Reflect.set(globalThis, '__fpLifecycleGate', gate)
    gate.appearance('delayed-old')
  })
  const inspect = () =>
    page.evaluate(() => {
      const gate = Reflect.get(globalThis, '__fpLifecycleGate') as LifecycleGate
      const rig = gate.game?.app.root?.findByName('viewmodel-rig')
      const pending = rig?.findByName('viewmodel-pending')
      const actors = rig?.find((node) => node.name === 'viewmodel') ?? []
      return {
        gates: gate.gates.length,
        roots: rig?.children.length ?? 0,
        actors: actors.length,
        visible: actors.filter((node) => node.enabled).length,
        stagingDisabled: Boolean(pending && !pending.enabled),
        textures: gate.device?.textures.size,
        buffers: gate.device?.buffers.size,
      }
    })
  try {
    await waitForGate(page, 1)
    const delayed = await inspect()
    check(
      delayed.roots === 2 &&
        delayed.actors === 2 &&
        delayed.visible === 0 &&
        delayed.stagingDisabled,
      'pending real GLB actor was enabled or unbounded',
      delayed,
    )
    await page.evaluate(() =>
      (Reflect.get(globalThis, '__fpLifecycleGate') as LifecycleGate).appearance('delayed-latest'),
    )
    await frames(page, 5)
    const cancelled = await inspect()
    check(
      cancelled.gates === 1 &&
        cancelled.roots === 1 &&
        cancelled.actors === 1 &&
        cancelled.visible === 0,
      'superseded real actor survived or loading was not serialized',
      cancelled,
    )
    await releaseGate(page, 0)
    await waitForGate(page, 2)
    const next = await inspect()
    check(
      next.roots === 2 && next.actors === 2 && next.visible === 0 && next.stagingDisabled,
      'latest real actor flashed before attachment readiness',
      next,
    )
    await releaseGate(page, 1)
    await page.waitForFunction(() => {
      const state = (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).debug().actors
      return state.loading === 0 && state.viewmodel.pending === 0 && state.viewmodel.arms === 1
    })
    await frames(page, 10)
    const settled = await inspect()
    check(
      settled.roots === 1 && settled.actors === 1 && settled.visible === 1,
      'replacement never presented',
      settled,
    )
    await page.screenshot({ path: `${output}/delayed-native-replacement.png` })
    const cancellation = await cancelLifeAndView(page, inspect)
    await page.evaluate(() =>
      (Reflect.get(globalThis, '__fpLifecycleGate') as LifecycleGate).appearance('dispose-pending'),
    )
    await waitForGate(page, 7)
    const disposing = await inspect()
    await page.evaluate(() =>
      (Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).destroy(),
    )
    await releaseGate(page, 6)
    await frames(page, 15)
    const disposed = await inspect()
    check(
      disposed.roots === 0 &&
        disposed.actors === 0 &&
        disposed.textures === 0 &&
        disposed.buffers === 0,
      'late GLB resolution resurrected disposed resources',
      disposed,
    )
    return {
      delayed,
      cancelled,
      next,
      settled,
      ...cancellation,
      disposing,
      disposed,
    }
  } finally {
    await page.evaluate(() => {
      const gate = Reflect.get(globalThis, '__fpLifecycleGate') as LifecycleGate
      gate.restore()
      for (const pending of gate.gates) {
        pending.release()
      }
    })
  }
}

/** Real input and native controller clocks, after the visual weapon/stance matrix has settled. */
export async function nativeActions<
  T extends { fov: number; arms: { controllers: { state?: string; time?: number }[] } },
>(
  page: Page,
  output: string,
  view: () => Promise<T>,
  presented: (sample: T, label: string) => void,
): Promise<Record<string, unknown>> {
  await page.keyboard.up('KeyC')
  await frames(page, 40)
  const hip = await view()
  await page.mouse.down({ button: 'right' })
  await frames(page, 30)
  await page.evaluate(() => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    const self = session.world.players[session.selfSlot]
    if (self) {
      self.ammo = 1
    }
    ;(Reflect.get(globalThis, '__playcanvasFrontier') as GameViewport).tap(8)
  })
  await page.waitForFunction(() => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    return (session.world.players[session.selfSlot]?.reloadTicks ?? 0) > 0
  })
  await frames(page, 15)
  const reload = await view()
  presented(reload, 'reload exits sights')
  check(Math.abs(reload.fov - hip.fov) < 1e-6, 'reload did not cancel ADS', reload)
  check(
    reload.arms.controllers.some((c) => c.state?.includes('Reload')),
    'native reload never played',
    reload,
  )
  await page.screenshot({ path: `${output}/reload-cancels-sights.png` })
  await page.mouse.up({ button: 'right' })
  await page.waitForFunction(() => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    return session.world.players[session.selfSlot]?.reloadTicks === 0
  })
  await page.keyboard.down('KeyW')
  await frames(page, 20)
  const moving = await view()
  presented(moving, 'moving')
  check(
    moving.arms.controllers.some((c) =>
      ['Stride_', 'Walk', 'Run'].some((state) => c.state?.includes(state)),
    ),
    'native gait never resumed',
    moving,
  )
  await page.keyboard.down('ShiftLeft')
  await frames(page, 35)
  const sprint = await view()
  presented(sprint, 'sprinting')
  check(
    sprint.arms.controllers.some((c) => c.state?.includes('Sprint')),
    'native sprint never played',
    sprint,
  )
  await page.keyboard.up('ShiftLeft')
  await page.keyboard.up('KeyW')
  await page.keyboard.down('Space')
  await page.waitForFunction(() => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    return session.players.get(session.selfId)?.grounded === false
  })
  const jumping = await view()
  presented(jumping, 'jumping')
  check(
    jumping.arms.controllers.some((c) => c.state === 'Jump_Loop'),
    'native jump never played',
    jumping,
  )
  await page.keyboard.up('Space')
  await page.waitForFunction(() => {
    const session = Reflect.get(globalThis, '__nativeFrontierSession') as FrontierSession
    return session.players.get(session.selfId)?.grounded === true
  })
  return {
    actions: {
      reload: reload.arms.controllers,
      moving: moving.arms.controllers,
      sprint: sprint.arms.controllers,
      jumping: jumping.arms.controllers,
    },
  }
}

interface ShadowWorld {
  castShadows: number
  controllers: { node: string; state?: string }[]
}

export function shadowShooting(world: ShadowWorld): boolean {
  return (
    world.castShadows > 0 &&
    world.controllers.some((c) => c.node === 'upper-body-pose' && c.state?.includes('Shoot'))
  )
}
export function unchangedBaseRay(before: ShotRay, after: ShotRay): boolean {
  // Origins follow player displacement; compare the authoritative direction and max range.
  return (
    Math.hypot(before.dx - after.dx, before.dy - after.dy, before.dz - after.dz) <= 1e-12 &&
    before.maxT === after.maxT
  )
}

export async function rejectParkedShadow<T extends { world: ShadowWorld }>(
  page: Page,
  view: () => Promise<T>,
  label: string,
): Promise<boolean> {
  await frames(page, 5)
  const parked = await view()
  const parkedMechanismRejected =
    parked.world.controllers.some((c) => c.state?.startsWith('Weapon_Shoot')) &&
    !shadowShooting(parked.world)
  check(
    parkedMechanismRejected,
    `${label} parked mechanism was accepted as a shadow action`,
    parked.world,
  )
  return parkedMechanismRejected
}
