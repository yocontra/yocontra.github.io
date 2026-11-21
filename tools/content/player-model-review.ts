/** Close-up fixture that runs in the development browser using the shipped native actor loader. */
import { Color, Entity } from 'playcanvas'
import { GameApplication } from '../../src/experiments/out-west/client/application.ts'
import { ASSETS } from '../../src/experiments/out-west/content/manifest.ts'
import {
  CATALOG,
  DEFAULT_LOADOUT,
  type Loadout,
} from '../../src/experiments/out-west/data/catalog.ts'
import { DuelActor } from '../../src/experiments/out-west/duel/native-actor.ts'
import type { RenderTier } from '../../src/experiments/out-west/platform/render-tier.ts'
import { equippedActor } from '../../src/experiments/out-west/scene/native-equipment.ts'

const poses = [
  { name: 'front-bare', pose: 'Idle', yaw: 0, hat: false, rake: false },
  { name: 'profile-bare', pose: 'Idle', yaw: 90, hat: false, rake: false },
  { name: 'rear-bare', pose: 'Idle', yaw: 155, hat: false, rake: false },
  { name: 'three-quarter-worn', pose: 'Idle', yaw: 32, hat: true, rake: false },
  { name: 'crouch-collar', pose: 'Crouch_Idle', yaw: 34, hat: true, rake: false },
  { name: 'aim-profile', pose: 'Idle_Gun_Pointing', yaw: 72, hat: true, rake: false },
  { name: 'raking-light', pose: 'Idle', yaw: -32, hat: false, rake: true },
] as const

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
  const fits = [
    { id: 'baked-player', outfit: undefined, paired: false },
    ...outfits.flatMap((outfit) => [
      { id: outfit, outfit, paired: false },
      { id: `${outfit}.pair`, outfit, paired: true },
    ]),
  ]

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
      actor = await equippedActor(game, loadout, {}, { local: true })
    } else {
      actor = await DuelActor.create(game, ASSETS.player.url, 'baked-player')
    }
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
    if (hats.length === 0) {
      throw new Error(`Missing hat attachment on ${actor.root.name}`)
    }
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
    layer.activeStateCurrentTime = 0.24
    anim.update(0)
    anim.playing = false
    keyLight.setEulerAngles(pose.rake ? 12 : 38, pose.rake ? -72 : -18, 0)
    const p = head.getPosition()
    game.camera.setPosition(p.x, p.y + 0.1, p.z + 1.04)
    game.camera.lookAt(p.x, p.y + 0.035, p.z)
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>((resolve) => game.app.once('postrender', () => resolve()))
    }
  }

  return {
    fits: fits.map(({ id }) => id),
    poses: poses.map(({ name }) => name),
    load,
    render,
  }
}
