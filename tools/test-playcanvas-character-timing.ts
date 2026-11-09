/** Native clock/footplant evidence, independent of browser refresh rate. */
import { mkdir, writeFile } from 'node:fs/promises'
import type { StandardMaterial, Texture } from 'playcanvas'
import { chromium, type Page } from 'playwright'
import type { NativeDirector } from '../src/experiments/out-west/duel/native-director.ts'
import type { nativeCharacterTiming } from './content/character-timing.ts'

const origin = process.env.OUT_WEST_URL ?? 'http://127.0.0.1:4390'
const output = process.env.OUT_WEST_EVIDENCE ?? '/tmp/out-west-character-timing'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  if (process.env.OW_PBR_ONLY === '1') {
    await nativeMaterialProof(page)
  } else {
    await page.goto(`${origin}/404`, { waitUntil: 'domcontentloaded' })
    const result = (await page.evaluate(async () => {
      const fixture = Reflect.get(globalThis, '__nativeTimingProbe')
      if (typeof fixture === 'function') {
        return fixture()
      }
      const path = '/tools/content/character-timing.ts'
      return (await import(path)).nativeCharacterTiming()
    })) as Awaited<ReturnType<typeof nativeCharacterTiming>>
    for (const gait of result.gaits) {
      if (
        Math.abs(gait.nativeTime - gait.rate * gait.wallSeconds) > 0.0001 ||
        gait.slip.contacts < 5 ||
        gait.slip.medianAbsolute > gait.speed * 0.08 + 0.02
      ) {
        throw new Error(`Unstable native gait/footplant: ${JSON.stringify(gait)}`)
      }
    }
    for (const shot of result.shots) {
      if (shot.duration <= 0 || Math.abs(shot.nativeTime - shot.duration) > 0.0001) {
        throw new Error(`Recoil did not complete in ${shot.seconds}s: ${JSON.stringify(shot)}`)
      }
      for (const mechanism of shot.mechanisms) {
        if (
          mechanism.duration <= 0 ||
          Math.abs(mechanism.nativeTime - mechanism.duration) > 0.0001
        ) {
          throw new Error(`Revolver mechanism clock disagrees: ${JSON.stringify(mechanism)}`)
        }
      }
    }
    for (const cue of result.cues) {
      if (Math.abs(cue.nativeTime - Math.min(cue.duration, 0.1)) > 0.0001) {
        throw new Error(`Nonhuman cue rate changed: ${JSON.stringify(cue)}`)
      }
    }
    if (errors.length > 0) {
      throw new Error(errors.join('; '))
    }
    await writeFile(`${output}/result.json`, JSON.stringify({ ...result, errors }, null, 2))
    console.log('PASS native30/60/100Hz gait clocks, planted toes and complete200ms recoil')
  }
  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }
} finally {
  await browser.close()
}

/** Keep the real menu, authored lighting and equipment pipeline in this visual regression. */
async function nativeMaterialProof(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.route('**/@vite/client', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: 'export const createHotContext=()=>({accept(){},dispose(){},on(){},off(){},send(){},prune(){},invalidate(){}});export const injectQuery=v=>v;export const updateStyle=()=>{};export const removeStyle=()=>{};',
    }),
  )
  await page.goto(`${origin}/experiments/out-west/#debug`)
  await page.waitForFunction(
    () => Boolean(Reflect.get(globalThis, '__ow')?.director?.player?.model.anim?.baseLayer),
    undefined,
    { timeout: 90_000 },
  )
  await page.addStyleTag({
    content: '.ow-title,.ow-hub,.ow-hud,astro-dev-toolbar{visibility:hidden!important}',
  })
  const initial = await page.evaluate(materialSetup)
  const frames: {
    day: number
    pose: string
    ggx: boolean
    materials: unknown
    assets: number
    textureBytes: number
    forwardDraws: number
  }[] = []
  for (const day of [0, 1]) {
    for (const pose of ['Idle_Character', 'Idle_Gun_Pointing']) {
      for (const ggx of [false, true]) {
        const frame = await page.evaluate(materialFrame, { day, pose, ggx })
        await page.screenshot({
          path: `${output}/${day === 0 ? 'day' : 'night'}-${pose}-${ggx ? 'ggx' : 'blinn'}.png`,
        })
        frames.push(frame)
      }
    }
  }
  for (let n = 0; n < frames.length; n += 2) {
    const control = frames[n]
    const native = frames[n + 1]
    if (!(control && native)) {
      throw new Error('Missing GGX/control frames')
    }
    const response = (frame: typeof control) =>
      JSON.stringify([frame.assets, frame.textureBytes, frame.forwardDraws])
    const unchanged = [control, native].every(
      (frame) => JSON.stringify(frame.materials) === JSON.stringify(initial.materials),
    )
    if (!unchanged || response(control) !== response(native)) {
      throw new Error(
        `GGX changed authored factors/maps or render resources: ${JSON.stringify({ control, native })}`,
      )
    }
  }
  const cleanup = await page.evaluate(async () => {
    const d: NativeDirector = Reflect.get(globalThis, '__ow').director
    const textures: Texture[] = Reflect.get(globalThis, '__pbrTextures')
    d.game.destroy()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (textures.some((texture) => texture.device)) {
      throw new Error('Disposed native materials retained GPU textures')
    }
    return {
      releasedTextures: textures.length,
      canvases: document.querySelectorAll('.pc-game-canvas').length,
    }
  })
  await writeFile(
    `${output}/pbr-result.json`,
    JSON.stringify({ initial, frames, cleanup }, null, 2),
  )
  console.log(
    'PASS actual native GGX cloth/skin/metal day/night, unchanged parameters/maps/resources, shared leases and GPU cleanup',
  )
}

async function materialSetup() {
  const d: NativeDirector = Reflect.get(globalThis, '__ow').director
  d.paused = true
  d.game.app.timeScale = 0
  d.game.app.off('update', Reflect.get(d, 'tick'))
  const actor = d.player
  if (!actor) {
    throw new Error('Missing actual equipped menu actor')
  }
  actor.place(2.4, 0, 7.5)
  actor.face(-15)
  const materials = [
    ...new Set(
      actor.root
        .findComponents('render')
        .flatMap((component) =>
          component.meshInstances.map((instance) => instance.material as StandardMaterial),
        ),
    ),
  ]
  if (!materials.every((material) => material.enableGGXSpecular)) {
    throw new Error('Native PBR still uses Blinn-Phong')
  }
  Reflect.set(globalThis, '__pbrMaterials', materials)
  const identities = new Map<Texture, number>()
  const snapshot = (material: StandardMaterial) => ({
    id: material.id,
    name: material.name,
    gloss: material.gloss,
    invert: material.glossInvert,
    metalness: material.metalness,
    bumpiness: material.bumpiness,
    reflectivity: material.reflectivity,
    vertex: material.glossVertexColor,
    vertexChannel: material.glossVertexColorChannel,
    glossChannel: material.glossMapChannel,
    metalChannel: material.metalnessMapChannel,
    maps: [material.diffuseMap, material.normalMap, material.glossMap, material.metalnessMap].map(
      (texture) => {
        if (!texture) {
          return null
        }
        if (!identities.has(texture)) {
          identities.set(texture, identities.size)
        }
        return { identity: identities.get(texture), url: texture.name }
      },
    ),
  })
  Reflect.set(globalThis, '__pbrSnapshot', () => materials.map(snapshot))
  const before = materials.map(snapshot)
  const assets = d.game.app.assets.list().length
  const path = '/src/experiments/out-west/scene/native-equipment.ts'
  const { equippedActor }: typeof import('../src/experiments/out-west/scene/native-equipment.ts') =
    await import(path)
  const catalog = '/src/experiments/out-west/data/catalog.ts'
  const { DEFAULT_LOADOUT }: typeof import('../src/experiments/out-west/data/catalog.ts') =
    await import(catalog)
  const twins = await Promise.all([
    equippedActor(d.game, DEFAULT_LOADOUT),
    equippedActor(d.game, DEFAULT_LOADOUT),
  ])
  if (
    JSON.stringify(before) !== JSON.stringify(materials.map(snapshot)) ||
    d.game.app.assets.list().length !== assets
  ) {
    throw new Error(
      'Repeated equipment changed native material parameters/maps or grew asset cache',
    )
  }
  twins[0]?.destroy()
  twins[1]?.destroy()
  if (
    materials.some((material) => !material.diffuseMap?.device) ||
    d.game.app.assets.list().length !== assets
  ) {
    throw new Error('Shared material lease retired the live menu maps')
  }
  const textures = [
    ...new Set(
      materials.flatMap((material) =>
        [material.diffuseMap, material.normalMap, material.glossMap].filter(
          (texture): texture is Texture => Boolean(texture),
        ),
      ),
    ),
  ]
  Reflect.set(globalThis, '__pbrTextures', textures)
  return { materials: before, assets, textures: textures.length, sharedLeaseRetained: true }
}

async function materialFrame({
  day: timeOfDay,
  pose: requested,
  ggx: enabled,
}: {
  day: number
  pose: string
  ggx: boolean
}) {
  const d: NativeDirector = Reflect.get(globalThis, '__ow').director
  const actor = d.player
  if (!actor) {
    throw new Error('Missing real menu actor')
  }
  await d.arenas.lighting(timeOfDay)
  actor.hold('revolver', requested === 'Idle_Gun_Pointing')
  actor.play(requested, 0)
  actor.model.anim?.update(0)
  const layer = actor.model.anim?.baseLayer
  if (layer) {
    layer.activeStateCurrentTime = requested === 'Idle_Character' ? 4 : 0.1
  }
  actor.model.anim?.update(0)
  const materials: StandardMaterial[] = Reflect.get(globalThis, '__pbrMaterials')
  for (const material of materials) {
    material.enableGGXSpecular = enabled
    material.update()
  }
  if (requested === 'Idle_Character') {
    d.game.camera.setPosition(2.4, 1.7, 11.8)
    d.game.camera.lookAt(2.4, 1.1, 7.5)
  } else {
    d.game.camera.setPosition(3.5, 1.7, 9.3)
    d.game.camera.lookAt(2, 1.4, 7.9)
  }
  for (let n = 0; n < 3; n++) {
    await new Promise(requestAnimationFrame)
  }
  return {
    day: timeOfDay,
    pose: requested,
    ggx: enabled,
    materials: Reflect.get(globalThis, '__pbrSnapshot')(),
    assets: d.game.app.assets.list().length,
    textureBytes: d.game.app.stats.vram.tex,
    forwardDraws: d.game.app.stats.drawCalls.forward,
  }
}
