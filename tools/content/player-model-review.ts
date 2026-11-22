/** Visual inspection fixture that runs in the development browser using the shipped native actor loader. */
import { Color, Entity } from 'playcanvas'
import { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { EQUIPMENT } from '../../src/experiments/out-west/content/equipment.ts'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import {
  CATALOG,
  DEFAULT_LOADOUT,
  type Loadout,
} from '../../src/experiments/out-west/data/catalog.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import type { RenderTier } from '../../src/experiments/out-west/platform/render-tier.ts'
import { equippedActor } from '../../src/experiments/out-west/scene/native-equipment.ts'

interface ReviewPose {
  name: string
  pose: string
  yaw: number
  hat: boolean
  rake?: boolean
  framing?: 'torso' | 'body'
  time?: number
}

const poses: readonly ReviewPose[] = [
  { name: 'front-bare', pose: 'Idle', yaw: 0, hat: false, rake: false },
  { name: 'profile-bare', pose: 'Idle', yaw: 90, hat: false, rake: false },
  { name: 'rear-bare', pose: 'Idle', yaw: 155, hat: false, rake: false },
  { name: 'three-quarter-worn', pose: 'Idle', yaw: 32, hat: true, rake: false },
  { name: 'crouch-collar', pose: 'Crouch_Idle', yaw: 34, hat: true, rake: false },
  { name: 'aim-profile', pose: 'Idle_Gun_Pointing', yaw: 72, hat: true, rake: false },
  { name: 'raking-light', pose: 'Idle', yaw: -32, hat: false, rake: true },
  { name: 'idle-body-front', pose: 'Idle', yaw: 0, hat: true, framing: 'body' },
  { name: 'idle-body-right', pose: 'Idle', yaw: 90, hat: true, framing: 'body' },
  { name: 'idle-body-left', pose: 'Idle', yaw: -90, hat: true, framing: 'body' },
  { name: 'idle-body-back', pose: 'Idle', yaw: 180, hat: true, framing: 'body' },
  { name: 'idle-back-torso', pose: 'Idle', yaw: 142, hat: true, framing: 'torso', rake: true },
  {
    name: 'walk-side-early',
    pose: 'Stride_Walk_0',
    yaw: 90,
    hat: true,
    framing: 'body',
    time: 0.15,
  },
  {
    name: 'walk-side-late',
    pose: 'Stride_Walk_0',
    yaw: 90,
    hat: true,
    framing: 'body',
    time: 0.55,
  },
  {
    name: 'walk-rear-early',
    pose: 'Stride_Walk_0',
    yaw: 150,
    hat: true,
    framing: 'body',
    time: 0.15,
  },
  {
    name: 'walk-rear-late',
    pose: 'Stride_Walk_0',
    yaw: 150,
    hat: true,
    framing: 'body',
    time: 0.55,
  },
  { name: 'crouch-body-side', pose: 'Crouch_Idle', yaw: 90, hat: true, framing: 'body' },
  { name: 'crouch-body-back', pose: 'Crouch_Idle', yaw: 160, hat: true, framing: 'body' },
  { name: 'aim-body-side', pose: 'Idle_Gun_Pointing', yaw: -90, hat: true, framing: 'body' },
  { name: 'aim-body-back', pose: 'Idle_Gun_Pointing', yaw: 145, hat: true, framing: 'body' },
]

export async function createPlayerModelReview(tier: RenderTier) {
  document.body.replaceChildren()
  document.body.style.margin = '0'
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const game = await GameApplication.create({
    canvas,
    viewport: document.body,
    pixelRatio: 1,
    tier,
  })
  const camera = game.camera.camera
  const sun = game.app.root.findByName('sun')
  if (!(camera && sun instanceof Entity && sun.light)) {
    throw new Error('Missing player review lighting or camera')
  }

  const keyLight: Entity = sun
  const skybox = game.app.scene.layers.getLayerByName('Skybox')
  if (skybox) {
    skybox.enabled = false
  }
  game.post?.grade(
    {
      sunElev: 38,
      bloom: 0,
      saturation: 1,
      contrast: 1,
      shadowTint: [1, 1, 1],
      highTint: [1, 1, 1],
      rays: 0,
    },
    false,
  )
  camera.fov = 28
  camera.clearColor.set(0.29, 0.29, 0.28)
  sun.light.color = new Color(1, 0.96, 0.9)
  const fill = new Entity('Player review fill', game.app)
  fill.addComponent('light', {
    type: 'directional',
    color: new Color(0.83, 0.9, 1),
    intensity: 0.65,
  })
  fill.setEulerAngles(15, 35, 0)
  game.app.root.addChild(fill)

  let actor: DuelActor | undefined
  const outfits = CATALOG.filter((item) => item.slot === 'outfit').map((item) => item.id)
  const fits: {
    id: string
    outfit: Loadout['outfit'] | undefined
    paired: boolean
    url: string | undefined
  }[] = [
    { id: 'baked-player', outfit: undefined, paired: false, url: ASSETS.player.url },
    ...outfits.flatMap((outfit) => [
      { id: outfit, outfit, paired: false, url: undefined },
      { id: `${outfit}.pair`, outfit, paired: true, url: undefined },
    ]),
  ]
  for (const [id, asset] of Object.entries(ASSETS)) {
    if (id.startsWith('outlaw-')) {
      fits.push({ id, outfit: undefined, paired: false, url: asset.url })
      if ('pair' in asset) {
        fits.push({ id: `${id}.pair`, outfit: undefined, paired: true, url: asset.pair.url })
      }
    }
  }

  async function load(id: string) {
    const fit = fits.find((candidate) => candidate.id === id)
    if (!fit) {
      throw new Error(`Unknown player fit ${id}`)
    }
    actor?.destroy()
    if (fit.outfit) {
      const loadout: Loadout = { ...DEFAULT_LOADOUT, outfit: fit.outfit }
      if (fit.paired) {
        loadout.gun = 'gun.hardins-pair'
      }
      const outfit: { url: string; pair?: { url: string } } | undefined =
        EQUIPMENT[fit.outfit as keyof typeof EQUIPMENT]
      const url = fit.paired ? outfit?.pair?.url : outfit?.url
      if (!url) {
        throw new Error(`Missing exact fitted body asset for ${id}`)
      }
      actor = await equippedActor(game, loadout, {}, { local: true })
      return url
    }
    if (!fit.url) {
      throw new Error(`Missing baked body asset for ${id}`)
    }
    actor = await DuelActor.create(game, fit.url, fit.id)
    return fit.url
  }

  async function render(name: string) {
    const pose = poses.find((candidate) => candidate.name === name)
    if (!(actor && pose)) {
      throw new Error(`Missing player or review scenario ${name}`)
    }
    const head = actor.root.findByName('Head')
    const anim = actor.model.anim
    if (!(head && anim)) {
      throw new Error(`Missing head joint or rig on ${actor.root.name}`)
    }
    const hats = actor.root.find((child) => child.name === 'mount.Head.accessory')
    for (const hat of hats) {
      hat.enabled = pose.hat
    }
    anim.playing = true
    actor.face(pose.yaw)
    actor.play(pose.pose, 0)
    const layer = anim.baseLayer
    if (!layer) {
      throw new Error(`Missing animation layer on ${actor.root.name}`)
    }
    layer.transition(layer.activeState, 0)
    layer.activeStateCurrentTime = pose.time ?? 0.24
    anim.update(0)
    anim.playing = false
    keyLight.setEulerAngles(pose.rake ? 12 : 38, pose.rake ? -72 : -18, 0)
    if (pose.framing) {
      const p = actor.root.getPosition()
      const target = pose.framing === 'torso' ? 1.42 : 0.96
      const distance = pose.framing === 'torso' ? 2.4 : 4.4
      game.camera.setPosition(p.x, p.y + target + 0.08, p.z + distance)
      game.camera.lookAt(p.x, p.y + target, p.z)
    } else {
      const p = head.getPosition()
      game.camera.setPosition(p.x, p.y + 0.1, p.z + 1.04)
      game.camera.lookAt(p.x, p.y + 0.035, p.z)
    }
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>((resolve) => game.app.once('postrender', () => resolve()))
    }
    const cameraPosition = game.camera.getPosition()
    const rotation = game.camera.getRotation()
    const crown = head.getPosition()
    return [
      cameraPosition.x,
      cameraPosition.y,
      cameraPosition.z,
      rotation.x,
      rotation.y,
      rotation.z,
      rotation.w,
      crown.x,
      crown.y,
      crown.z,
    ]
  }

  return {
    fits: fits.map(({ id }) => id),
    poses: poses.map(({ name }) => name),
    load,
    render,
  }
}
