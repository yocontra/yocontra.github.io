/** Browser-side studio for deterministic character, garment, LOD and action review. */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from 'three'
import {
  ANIM_AIM,
  ANIM_IDLE,
  EF_ALIVE,
  STANCE_ADS,
  WEAPON_REVOLVER,
  WEAPON_RIFLE,
  WEAPON_SHOTGUN,
} from '../../src/experiments/out-west/contract/town.ts'
import { CATALOG, DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import { OUTLAWS } from '../../src/experiments/out-west/data/outlaws.ts'
import type { Assets } from '../../src/experiments/out-west/engine/assets.ts'
import { ViewModel } from '../../src/experiments/out-west/ffa/client/viewmodel.ts'
import { vatCacheStats } from '../../src/experiments/out-west/ffa/scene/crowd/vat.ts'
import { Crowd, type CrowdPlayer } from '../../src/experiments/out-west/ffa/scene/crowd.ts'
import { lookFor } from '../../src/experiments/out-west/ffa/scene/looks.ts'
import type { Actor } from '../../src/experiments/out-west/scene/actor.ts'
import { castActor } from '../../src/experiments/out-west/scene/cast.ts'
import { dressedActor } from '../../src/experiments/out-west/scene/loadout.ts'
import { propObject } from '../../src/experiments/out-west/scene/props.ts'
import { revolverDef } from '../../src/experiments/out-west/scene/revolver.ts'
import { stressCorpseResidency } from './corpse-stress.ts'
import { type GpuEvidence, measureFar } from './gpu.ts'
import { type CropFrame, captureTailored, type ModelEvidence } from './tailored-preview.ts'
import { markCuffs, measureCuffs } from './tailoring.ts'

export interface Capture {
  group: string
  name: string
  url: string
}
export interface FitFinding {
  subject: string
  minY: number
  handGripM: number | null
  cuffs?: { side: string; gapM: number; position: number[]; wrist: number[] }[]
}
interface Source {
  assets: Assets
  scene: Scene
}

/** Uses the running Frontier's context and cached assets; no new WebGL context or live writes. */
export async function captureCharacters(artOnly = false): Promise<{
  captures: Capture[]
  models: ModelEvidence[]
  fit: FitFinding[]
  cache: CacheEvidence
  gpu: GpuEvidence
}> {
  const source = Reflect.get(globalThis, '__crowd') as Source | undefined
  const renderer = Reflect.get(globalThis, '__owRenderer') as { gl: WebGLRenderer } | undefined
  if (!(source && renderer)) {
    throw new Error('Open local Frontier with #perf first')
  }
  const assets = source.assets
  const gl = renderer.gl
  const scene = new Scene()
  scene.background = new Color(0x4d_46_3c)
  scene.environment = source.scene.environment
  scene.environmentIntensity = 0.7
  const key = new DirectionalLight(0xff_ee_d5, 3.2)
  key.position.set(-2, 4, 4)
  const fill = new DirectionalLight(0xb9_ce_e4, 1.3)
  fill.position.set(3, 2, -2)
  scene.add(key, fill, new AmbientLight(0xff_ff_ff, 0.8))
  const floor = new Mesh(
    new PlaneGeometry(12, 12),
    new MeshStandardMaterial({ color: 0x60_56_46, roughness: 1 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.008
  scene.add(floor)
  const cam = new PerspectiveCamera(32, 360 / 480, 0.05, 20)
  cam.position.set(2.5, 1.6, 3.7)
  cam.lookAt(0, 0.88, 0)
  const rt = new WebGLRenderTarget(360, 480, { samples: 4 })
  rt.texture.colorSpace = SRGBColorSpace
  const captures: Capture[] = []
  const fit: FitFinding[] = []
  const take = (group: string, name: string, subjectScene = scene, lens = cam): void => {
    const previous = gl.getRenderTarget()
    const tone = gl.toneMapping
    const exposure = gl.toneMappingExposure
    gl.toneMapping = ACESFilmicToneMapping
    gl.toneMappingExposure = 1
    gl.setRenderTarget(rt)
    gl.clear()
    gl.render(subjectScene, lens)
    const px = new Uint8Array(360 * 480 * 4)
    gl.readRenderTargetPixels(rt, 0, 0, 360, 480, px)
    gl.setRenderTarget(previous)
    gl.toneMapping = tone
    gl.toneMappingExposure = exposure
    const canvas = document.createElement('canvas')
    canvas.width = 360
    canvas.height = 480
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('No 2D canvas')
    }
    const image = ctx.createImageData(360, 480)
    for (let y = 0; y < 480; y++) {
      image.data.set(px.subarray((479 - y) * 360 * 4, (480 - y) * 360 * 4), y * 360 * 4)
    }
    ctx.putImageData(image, 0, 0)
    captures.push({ group, name, url: canvas.toDataURL('image/png') })
  }
  const pose = (a: Actor, group: string, name: string): void => {
    scene.add(a.root)
    a.root.updateMatrixWorld(true)
    let minY = Number.POSITIVE_INFINITY
    const v = new Vector3()
    for (const mesh of a.meshes) {
      for (let i = 0; i < mesh.geometry.getAttribute('position').count; i++) {
        mesh.getVertexPosition(i, v)
        v.applyMatrix4(mesh.matrixWorld)
        minY = Math.min(minY, v.y)
      }
    }
    let handGripM: number | null = null
    if (a.handR && a.gun && a.anatomy) {
      const grip = a.anatomy.grip.clone().applyMatrix4(a.gun.matrixWorld)
      handGripM = grip.distanceTo(a.handR.getWorldPosition(new Vector3()))
    }
    const cuffs = measureCuffs(a)
    fit.push({ subject: name, minY, handGripM, cuffs })
    take(group, name)
    a.root.removeFromParent()
  }
  const gun = propObject(revolverDef(0.32))
  for (const [i, outlaw] of OUTLAWS.entries()) {
    await assets.lookReady(outlaw.look)
    const actor = castActor(assets, { ...outlaw, gun })
    actor.play('Idle', 0)
    actor.update(0)
    pose(actor, 'outlaws', `${String(i + 1).padStart(2, '0')}-${outlaw.name}`)
    crop(
      actor,
      { group: 'faces', name: outlaw.name, y: actor.height * 0.88, distance: 1.2 },
      { scene, cam, take },
    )
    actor.dispose()
  }
  const models = await captureTailored(assets, gun, {
    pose,
    crop: (actor, frame) => crop(actor, frame, { scene, cam, take }),
  })
  for (const item of CATALOG.filter((candidate) => candidate.slot === 'outfit')) {
    const actor = dressedActor(assets.player, revolverDef(0.3), {
      ...DEFAULT_LOADOUT,
      outfit: item.id,
    })
    actor.draw()
    actor.update(0)
    pose(actor, 'outfits', item.id)
    if (item.id === 'outfit.wool-duster' || item.id === 'outfit.gamblers-frock') {
      for (const [view, turn] of [
        ['front', 0],
        ['side', Math.PI / 2],
        ['back', Math.PI],
      ] as const) {
        actor.root.rotation.y = Math.atan2(2.5, 3.7) + turn
        pose(actor, 'coat-turns', `${item.id}-${view}`)
      }
    }
    actor.dispose()
  }
  if (artOnly) {
    rt.dispose()
    return {
      captures,
      models,
      fit,
      cache: { waves: [], released: vatCacheStats(), lateChildren: [0, 0] },
      gpu: {
        maxVertexAttribs: 0,
        programs: [],
        farBodyPixels: 0,
        magentaBodyPixels: 0,
        recoloredBodyPixels: 0,
        bodies: [],
      },
    }
  }
  const preview = await captureCrowd(assets, scene, take)
  const gpu = measureFar(preview, gl, {
    scene,
    camera: cam,
    target: rt,
    take: (name) => take('gpu-proof', name),
  })
  captureFirstPerson(assets, scene, take)
  preview.dispose()
  const cache =
    gpu.farBodyPixels > 0
      ? await stressCache(scene, assets, gl, cam)
      : { waves: [], released: vatCacheStats(), lateChildren: [0, 0] as [number, number] }
  rt.dispose()
  return { captures, models, fit, cache, gpu }
}

function crop(
  actor: Actor,
  frame: CropFrame,
  stage: { scene: Scene; cam: PerspectiveCamera; take: (group: string, name: string) => void },
): void {
  const position = stage.cam.position.clone()
  const rotation = stage.cam.quaternion.clone()
  stage.scene.add(actor.root)
  const yaw = frame.yaw ?? Math.atan(0.32)
  stage.cam.position.set(
    Math.sin(yaw) * frame.distance,
    frame.y + 0.05,
    Math.cos(yaw) * frame.distance,
  )
  stage.cam.lookAt(0, frame.y, 0)
  stage.take(frame.group, frame.name)
  if (frame.group === 'tailoring') {
    markCuffs(actor, stage, frame.name)
  }
  actor.root.removeFromParent()
  stage.cam.position.copy(position)
  stage.cam.quaternion.copy(rotation)
  stage.cam.updateMatrixWorld(true)
}

async function captureCrowd(
  assets: Assets,
  scene: Scene,
  take: (group: string, name: string) => void,
): Promise<Crowd> {
  const preview = new Crowd(scene, assets, 1)
  preview.readScale = 1
  preview.casters = 0
  const rider: CrowdPlayer = {
    id: 7,
    x: 0,
    y: 0,
    z: 0,
    aim: Math.PI / 2,
    vx: 0,
    vz: 0,
    anim: ANIM_IDLE,
    stance: 0,
    flags: EF_ALIVE,
    self: true,
  }
  for (const item of CATALOG.filter((candidate) => candidate.slot === 'outfit')) {
    preview.setLook(7, lookFor([item.id], 7))
    await preview.prepareLooks()
    await preview.precast(1, 7, () => 0)
    for (const weapon of [WEAPON_REVOLVER, WEAPON_RIFLE, WEAPON_SHOTGUN]) {
      rider.weapon = weapon
      rider.anim = ANIM_AIM
      rider.stance = STANCE_ADS
      for (const near of [1, 0]) {
        preview.near = near
        for (let frame = 0; frame < 12; frame++) {
          preview.update([rider], 0, 0, 1 / 60, 2 + frame / 60)
        }
        take('lod', `${item.id}-${weapon}-${near ? 'near' : 'far'}`)
      }
    }
    rider.weapon = WEAPON_REVOLVER
    rider.vx = 1.4
    for (const near of [1, 0]) {
      preview.near = near
      for (let frame = 0; frame < 40; frame++) {
        preview.update([rider], 0, 0, 1 / 60, 4 + frame / 60)
      }
      take('aimed-gait', `${item.id}-${near ? 'near' : 'far'}`)
    }
    rider.vx = 0
  }
  return preview
}

function captureFirstPerson(
  assets: Assets,
  scene: Scene,
  take: (group: string, name: string, scene: Scene, lens: PerspectiveCamera) => void,
): void {
  const vm = new ViewModel(assets)
  vm.visible = true
  vm.setLens(360 / 480, 72)
  vm.scene.environment = scene.environment
  vm.scene.environmentIntensity = 0.7
  for (const item of CATALOG.filter((candidate) => candidate.slot === 'gun')) {
    vm.setLook(lookFor([item.id], 7))
    for (const ads of [false, true]) {
      for (let frame = 0; frame < 40; frame++) {
        vm.update(
          {
            dt: 1 / 60,
            lookYaw: 0,
            lookPitch: 0,
            speed: 0,
            sprinting: false,
            ads,
            crouched: false,
            sliding: false,
            grounded: true,
            reload: null,
            weapon: WEAPON_REVOLVER,
            wall: 10,
          },
          new Vector3(-0.4, 0.8, 0.3),
        )
      }
      take('first-person', `${item.id}-${ads ? 'ads' : 'hip'}`, vm.scene, vm.camera)
    }
  }

  vm.setLook(lookFor(['gun.rusty-six'], 7))
  for (const weapon of [WEAPON_RIFLE, WEAPON_SHOTGUN]) {
    for (const state of ['hip', 'ads', 'reload']) {
      for (let frame = 0; frame < 40; frame++) {
        vm.update(
          {
            dt: 1 / 60,
            lookYaw: 0,
            lookPitch: 0,
            speed: 0,
            sprinting: false,
            ads: state === 'ads',
            crouched: false,
            sliding: false,
            grounded: true,
            reload: state === 'reload' ? 0.55 : null,
            weapon,
            wall: 10,
          },
          new Vector3(-0.4, 0.8, 0.3),
        )
      }
      take(
        'first-person',
        `${weapon === WEAPON_RIFLE ? 'rifle' : 'shotgun'}-${state}`,
        vm.scene,
        vm.camera,
      )
    }
  }
  vm.dispose()
}

interface CacheEvidence {
  waves: {
    active: number
    idle: number
    references: number
    loading: number
    queued: number
    variants: number
    draws: number
    textures: number
    geometries: number
    rendererTextureBytes: number
    positionErrorM: number
    normalErrorDeg: number
  }[]
  released: ReturnType<typeof vatCacheStats>
  lateChildren: [number, number]
  corpses?: Awaited<ReturnType<typeof stressCorpseResidency>>
}

async function stressCache(
  scene: Scene,
  assets: Assets,
  gl: WebGLRenderer,
  camera: PerspectiveCamera,
): Promise<CacheEvidence> {
  const crowd = new Crowd(scene, assets, 0)
  crowd.readScale = 1
  crowd.casters = 0
  const outfits = CATALOG.filter((item) => item.slot === 'outfit')
  const extras = ['extra.red-bandana', 'extra.black-bandana', 'extra.tin-star', 'extra.handlebar']
  const holsters = ['holster.plain-leather', 'holster.silver-conchos', 'holster.buscadero']
  const waves: CacheEvidence['waves'] = []
  const players: CrowdPlayer[] = []
  for (let i = 0; i < 32; i++) {
    players.push({
      id: i + 40,
      x: (i % 8) * 2,
      y: 0,
      z: Math.floor(i / 8) * 2,
      aim: Math.PI / 2,
      vx: 1,
      vz: 0,
      anim: ANIM_AIM,
      stance: STANCE_ADS,
      flags: EF_ALIVE,
      self: false,
      weapon: WEAPON_REVOLVER,
    })
  }
  for (let wave = 0; wave < 3; wave++) {
    for (let i = 0; i < 32; i++) {
      const outfit = outfits[(i + wave) % outfits.length]?.id ?? 'outfit.trail-duds'
      const extra = extras[Math.floor(i / 8) % extras.length] ?? 'extra.red-bandana'
      const holster =
        holsters[(Math.floor(i / 4) + wave) % holsters.length] ?? 'holster.plain-leather'
      crowd.setLook(
        i + 40,
        lookFor(
          [outfit, extra, holster, i % 2 ? 'gun.hardins-pair' : 'gun.engraved-ivory'],
          i + 40,
        ),
      )
    }
    await crowd.prepareLooks()
    await crowd.precast(2, -1, (id) => id)
    crowd.near = 2
    crowd.update(players, 0, 0, 1 / 60, 10 + wave)
    gl.info.reset()
    gl.render(scene, camera)
    const vats = Reflect.get(crowd, 'vats') as Map<
      string,
      { bake: { quantization: { positionM: number; normalDeg: number } } }
    >
    const variants = vats.size
    const quantization = [...vats.values()].map((v) => v.bake.quantization)
    const textureBytes = Reflect.get(globalThis, '__owTextureBytes') as () => number
    waves.push({
      ...vatCacheStats(),
      variants,
      draws: gl.info.render.calls,
      textures: gl.info.memory.textures,
      geometries: gl.info.memory.geometries,
      rendererTextureBytes: textureBytes(),
      positionErrorM: Math.max(...quantization.map((error) => error.positionM)),
      normalErrorDeg: Math.max(...quantization.map((error) => error.normalDeg)),
    })
  }
  const corpses = await stressCorpseResidency({ scene, crowd, players, gl, camera })
  for (const player of players) {
    crowd.remove(player.id)
  }
  crowd.dispose()
  const released = vatCacheStats()
  const pending = new Crowd(scene, assets, 0)
  const look = lookFor(['outfit.wool-duster', 'extra.red-bandana'], 799)
  look.look.coat = 0x1a_32_4f
  look.key += '/cancelled'
  pending.setLook(799, look)
  const finished = pending.prepareLooks()
  pending.dispose()
  const children = pending.root.children.length
  await finished
  return { waves, released, lateChildren: [children, pending.root.children.length], corpses }
}
