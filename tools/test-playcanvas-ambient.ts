/** Complete mounted native scenes, seated placement and independent spectator animation. */
import { mkdir, writeFile } from 'node:fs/promises'
import type { Entity } from 'playcanvas'
import { chromium } from 'playwright'
import type { DuelActor } from '../src/experiments/out-west/duel/native-actor.ts'
import type {
  NativeDirector,
  NativePhase,
} from '../src/experiments/out-west/duel/native-director.ts'

const output = process.env.OW_EVIDENCE ?? '/tmp/out-west-complete-scene-evidence-after'
const crowdOnly = process.env.OW_CROWD_ONLY === '1'
const baseline = process.env.OW_BASELINE === '1'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors: string[] = []
page.on('pageerror', (e) => errors.push(e.message))
const records: unknown[] = []
try {
  await page.route('**/@vite/client', (r) =>
    r.fulfill({
      contentType: 'text/javascript',
      body: `export const createHotContext = () => ({ accept() {}, dispose() {}, on() {}, off() {}, send() {}, prune() {}, invalidate() {} });
export const injectQuery = value => value;
export const updateStyle = () => {};
export const removeStyle = () => {};`,
    }),
  )
  await page.goto(
    `${process.env.OW_ORIGIN ?? 'http://127.0.0.1:4390'}/experiments/out-west/#debug&level=1`,
  )
  await page.waitForFunction(() => Boolean(Reflect.get(globalThis, '__ow')), null, {
    timeout: 90_000,
  })
  await page.locator('.ow-start').click()
  await page.locator('.ow-title').waitFor({ state: 'detached', timeout: 10_000 })
  await page.evaluate(async () => {
    const d: NativeDirector = Reflect.get(globalThis, '__ow').director
    await d.startLevel(0)
    d.enter('cock')
    d.paused = true
    d.c.hud.hideCard()
    Reflect.set(globalThis, '__sceneView', { position: [2, 2.2, -7], target: [6, 1.6, 6] })
    d.game.app.on('prerender', () => {
      const v: { position: [number, number, number]; target: [number, number, number] } =
        Reflect.get(globalThis, '__sceneView')
      d.game.camera.setPosition(...v.position)
      d.game.camera.lookAt(...v.target)
    })
  })
  await page.addStyleTag({
    content:
      '.ow-hud,.ow-cap-call,.ow-cap-fake,.ow-cap-line,.ow-letter,.ow-card,.ow-walk-hint,.ow-input-hint,astro-dev-toolbar{visibility:hidden!important}',
  })
  async function capture(
    name: string,
    position: number[],
    target: number[],
    reaction: { phase?: NativePhase; cue?: string } = {},
  ) {
    const state = await page.evaluate(
      async ({ position: eye, target: look, phase: stage, cue: fake }) => {
        const d: NativeDirector = Reflect.get(globalThis, '__ow').director
        d.enter(stage)
        if (fake) {
          d.cue(fake)
        }
        Reflect.set(globalThis, '__sceneView', { position: eye, target: look })
        for (let n = 0; n < 8; n++) {
          await new Promise(requestAnimationFrame)
        }
        return {
          arena: d.arenas.id,
          phase: d.phase,
          life: d.atmosphere.stats,
          animations: d.game.stage
            .find((n) =>
              ['townsfolk-', 'town-horse-', 'town-crow-', 'town-hen-', 'fakeout-dog'].some(
                (prefix) => n.name.startsWith(prefix),
              ),
            )
            .filter((n) => n.enabled)
            .map((n) => ({
              name: n.name,
              position: n.getPosition().toArray(),
              clip: (n as Entity).findComponents('anim')[0]?.baseLayer?.activeState,
            })),
        }
      },
      { position, target, phase: reaction.phase ?? 'cock', cue: reaction.cue },
    )
    await page.screenshot({ path: `${output}/${name}.png` })
    records.push({ name, ...state })
    console.log(name, state.arena, state.life)
  }
  const anchored = await page.evaluate(() => {
    const d: NativeDirector = Reflect.get(globalThis, '__ow').director
    const folk: {
      actor: { root: Entity; model: Entity }
      home: { habit?: string; y: number; floor?: number; door?: readonly number[] }
      hipsHeight: number
    }[] = Reflect.get(d.atmosphere, 'folk')
    return folk
      .filter((f) => f.home.habit === 'sit' || f.home.habit === 'whittle')
      .map((f) => ({
        habit: f.home.habit,
        rootY: f.actor.root.getPosition().y,
        expectedRootY: f.home.y - (f.hipsHeight - 0.1),
        hipsY: f.actor.model.findByName('Hips')?.getPosition().y,
        seatY: f.home.y,
        clip: f.actor.model.anim?.baseLayer?.activeState,
      }))
  })
  if (
    !crowdOnly &&
    (anchored.length !== 3 ||
      anchored.some((f) => Math.abs(f.rootY - f.expectedRootY) > 0.001 || f.clip !== 'Town_Sit'))
  ) {
    throw new Error(`Spectator seat anchoring regressed: ${JSON.stringify(anchored)}`)
  }
  records.push({ anchored })
  const identities = await page.evaluate(() => {
    const d: NativeDirector = Reflect.get(globalThis, '__ow').director
    const folk = Reflect.get(d.atmosphere, 'folk') as { actor: DuelActor }[]
    const actors = [d.player, d.enemy, ...folk.map((f) => f.actor)].filter(
      (actor): actor is DuelActor => actor !== null,
    )
    const controllers = new Set<unknown>()
    const skins = new Set<unknown>()
    const bones = new Set<unknown>()
    const meshes = new Set<unknown>()
    const sharedMeshes: unknown[] = []
    const unique = (values: Iterable<unknown>, seen: Set<unknown>, name: string) => {
      for (const value of values) {
        if (seen.has(value)) {
          throw new Error(`Actors share a native ${name}`)
        }
        seen.add(value)
      }
    }
    for (const actor of actors) {
      const instances = actor.model
        .findComponents('render')
        .flatMap((render) => render.meshInstances)
      unique(actor.root.findComponents('anim'), controllers, 'controller')
      const ownSkins = new Set(
        instances.flatMap((instance) => (instance.skinInstance ? [instance.skinInstance] : [])),
      )
      const ownBones = new Set([...ownSkins].flatMap((skin) => skin.bones))
      for (const bone of ownBones) {
        if (!bone.isDescendantOf(actor.model)) {
          throw new Error('Skin bound outside its actor')
        }
      }
      unique(ownSkins, skins, 'SkinInstance')
      unique(ownBones, bones, 'bone')
      const ownMeshes = instances.map((instance) => instance.mesh)
      sharedMeshes.push(...ownMeshes.filter((mesh) => meshes.has(mesh)))
      for (const mesh of ownMeshes) {
        meshes.add(mesh)
      }
    }
    if (sharedMeshes.length === 0) {
      throw new Error('Fixture did not exercise shared native geometry')
    }
    d.game.app.timeScale = 0
    const snapshot = () => {
      for (const { actor } of folk) {
        const layer = actor.model.anim?.baseLayer
        if (layer) {
          layer.activeStateCurrentTime = 0.25
        }
        actor.model.anim?.update(0)
      }
      return folk.map(({ actor }) => ({
        name: actor.root.name,
        root: actor.root.getGuid(),
        model: actor.model.getGuid(),
        controller: actor.model.anim?.entity.getGuid(),
        enabled: actor.model.anim?.enabled,
        clip: actor.model.anim?.baseLayer?.activeState,
        position: actor.root.getPosition().toArray(),
        pose: ['Hips', 'Head', 'UpperArmR', 'WristR'].map((name) => {
          const bone = actor.model.findByName(name)
          return [bone?.getLocalPosition().toArray(), bone?.getLocalRotation().toArray()]
        }),
      }))
    }
    d.game.app.systems.fire('animationUpdate', 0.3)
    Reflect.set(globalThis, '__crowdSnapshot', snapshot)
    return {
      actors: actors.length,
      controllers: controllers.size,
      skins: skins.size,
      bones: bones.size,
      sharedMeshes: sharedMeshes.length,
      before: snapshot(),
    }
  })
  records.push({ identities })
  for (const stage of ['before', 'call', 'shot', 'cue', 'win', 'lose', 'coward'] as const) {
    const state = await page.evaluate(async (next) => {
      const d: NativeDirector = Reflect.get(globalThis, '__ow').director
      if (next === 'call') {
        d.enter('wait')
        d.call()
      } else if (next === 'shot') {
        const path = '/src/experiments/out-west/duel/native-shot.ts'
        const { duelShot } = await import(path)
        duelShot(d, d.player, d.enemy)
      } else if (next === 'cue') {
        d.atmosphere.cue('horse', d.enemy)
      } else if (next !== 'before') {
        d.enter(next)
        d.enemy?.play('Death', 0)
      }
      d.atmosphere.update(0.1, d.phase)
      d.game.app.systems.fire('animationUpdate', 0.3)
      const crowd = Reflect.get(globalThis, '__crowdSnapshot')()
      Reflect.set(globalThis, '__sceneView', { position: [-1, 2.3, 8], target: [-10, 2, 17] })
      await new Promise(requestAnimationFrame)
      const horse = d.game.stage.findByName('town-horse-0') as Entity | null
      const crow = d.game.stage.findByName('town-crow-0') as Entity | null
      return {
        stage: next,
        enemy: d.enemy?.model.anim?.baseLayer?.activeState,
        horse: horse?.findComponents('anim')[0]?.baseLayer?.activeState,
        crow: crow?.findComponents('anim')[0]?.baseLayer?.activeState,
        crowd,
      }
    }, stage)
    await page.screenshot({ path: `${output}/crowd-${stage}.png` })
    records.push(state)
    if (JSON.stringify(state.crowd) !== JSON.stringify(identities.before) && !baseline) {
      throw new Error(`Duel ${stage} changed an independent spectator: ${JSON.stringify(state)}`)
    }
    if (stage === 'cue' && state.horse !== 'Idle_HitReact_Left') {
      throw new Error('Horse fakeout no longer plays its own reaction')
    }
    if (stage === 'win' && state.crow !== 'Fly') {
      throw new Error('Birds no longer take off after the duel')
    }
  }
  if (!crowdOnly) {
    await page.evaluate(() => {
      const d: NativeDirector = Reflect.get(globalThis, '__ow').director
      d.game.app.timeScale = 1
      d.atmosphere.arrange(d.arenas.life)
      d.enter('cock')
      d.enemy?.play('Idle', 0)
    })
    await capture('street-horse-and-doorfolk', [2, 2.2, -4], [7, 1.6, 5])
    await capture('street-veranda-folk-horse', [-1, 2.3, 8], [-10, 2, 17])
    await capture('street-birds-and-hens', [-2, 1.6, 20], [-8.4, 1.3, 26])
    await capture('street-dog-and-leaning-folk', [3, 1.9, 17], [9.4, 1.2, 24])
    await capture('horse-fakeout', [2, 2.2, -4], [7, 1.6, 5], { cue: 'horse' })
    await capture('folk-call-reaction', [-1, 2.3, 8], [-10, 2, 17], { phase: 'call' })
    await capture('birds-flight-and-hens-scatter', [-2, 1.8, 20], [-7.8, 2.2, 26], { phase: 'win' })
    await capture('townsfolk-keep-their-habits', [-1, 2.3, 8], [-10, 2, 17], { phase: 'win' })
    for (const [level, name] of [
      [6, 'depot-life'],
      [10, 'mission-life'],
      [13, 'bank-life'],
      [16, 'finale-clock-life'],
    ] as const) {
      await page.evaluate(async (levelIndex) => {
        const d: NativeDirector = Reflect.get(globalThis, '__ow').director
        await d.startLevel(levelIndex)
        d.paused = true
        d.enter('cock')
        d.c.hud.hideCard()
      }, level)
      const v = await page.evaluate(() => {
        const d: NativeDirector = Reflect.get(globalThis, '__ow').director
        const stand = d.arenas.life.horses[0] ?? d.arenas.life.folk[0]
        if (!stand) {
          throw new Error('Arena has no ambient inspection point')
        }
        return {
          position: [stand.x - 5, stand.y + 2.2, stand.z - 6],
          target: [stand.x, stand.y + 1.3, stand.z],
        }
      })
      await capture(name, v.position, v.target)
    }
  }
  await page.evaluate(() => Reflect.get(globalThis, '__ow').destroy())
  await writeFile(
    `${output}/results.json`,
    JSON.stringify(
      {
        scope:
          'Actual mounted NativeDirector and ambient components, paused local duel logic with inspection camera; native animation/reactions continue.',
        records,
        errors,
      },
      null,
      2,
    ),
  )
  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }
} finally {
  await browser.close()
}
