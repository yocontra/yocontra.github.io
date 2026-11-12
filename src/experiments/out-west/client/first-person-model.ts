/** One native local arms presentation; the physical rider and its shadow never move with it. */
import {
  type AnimComponentLayer,
  Entity,
  type GraphNode,
  Layer,
  Mat4,
  type MeshInstance,
  math,
  Quat,
  SHADER_FORWARD,
  Vec3,
} from 'playcanvas'
import { CONTENT_VERSION } from '../content/manifest.ts'
import { VIEWMODELS } from '../content/viewmodels.ts'
import { DEFAULT_LOADOUT } from '../data/catalog.ts'
import type { DuelActor } from '../duel/native-actor.ts'
import type { Player } from '../ffa/sim/types.ts'
import type { PlayerInput, PlayerState } from '../runtime/protocol.ts'
import { RECOIL_SECONDS } from '../scene/native-animation-timing.ts'
import { attachHeldWeapon, equippedActor, fitId } from '../scene/native-equipment.ts'
import { animateRider, heldWeapon } from './actor-animation.ts'
import { createRiderPose, type RiderPose } from './actor-pose.ts'
import type { Appearance } from './actors.ts'
import type { GameApplication } from './application.ts'
import { ViewmodelMotion } from './first-person-motion.ts'
import {
  advanceSights,
  type HeldWeapon,
  RESTING_SIGHT,
  SIGHTS,
  type Sight,
  sightFov,
  sightState,
} from './first-person-sights.ts'

export interface FirstPersonRequest {
  id: string
  world: DuelActor
  player: PlayerState
  domain: Player | undefined
  appearance: Appearance | undefined
}
interface Arms {
  key: string
  url: string
  actor: DuelActor
  pose: RiderPose
  clip: string
  aim: AnimComponentLayer
  weaponLayer: AnimComponentLayer
  firingUntil: number
  head: GraphNode | null
}
// Viewmodel projection on the screen's shorter axis, independent of the player's world FOV.
// Portrait screens reveal far more forearm below the gun, so their projection is wider.
const VIEWMODEL_FOV = { landscape: 58, portrait: 68 }
const SIGHTED_FOV = { landscape: 50, portrait: 58 }
// Long guns sit forward so the shouldered stock frames the view without exposing cut sleeves.
const HIP: Record<HeldWeapon, Vec3> = {
  revolver: new Vec3(0.02, -0.01, -0.06),
  rifle: new Vec3(0.03, -0.015, -0.15),
  shotgun: new Vec3(0.03, -0.015, -0.15),
}
const facing = new Quat().setFromEulerAngles(0, 180, 0)
const inverseRoot = new Mat4()
const local = new Mat4()
const basis = new Mat4()
const eye = new Vec3()
const front = new Vec3()
const rear = new Vec3()
const along = new Vec3()
const up = new Vec3()
const side = new Vec3()
const hipPosition = new Vec3()
const hipRotation = new Quat()
const targetPosition = new Vec3()
const targetRotation = new Quat()

function armsKey(request: FirstPersonRequest): string {
  const loadout = request.appearance?.loadout ?? DEFAULT_LOADOUT
  return `${fitId(loadout)}:${request.appearance?.key ?? 'default'}`
}

/** The viewmodel layer clears depth so arms never clip into nearby walls; it shares the lights. */
function viewmodelLayer(game: GameApplication): { layer: Layer; dispose: () => void } {
  const layers = game.app.scene.layers
  const world = layers.getLayerByName('World')
  if (!world) {
    throw new Error('Missing native World layer')
  }
  const layer = new Layer({ name: 'Viewmodel', clearDepthBuffer: true })
  const index = layers.getTransparentIndex(world)
  layers.insertOpaque(layer, index + 1)
  layers.insertTransparent(layer, index + 2)
  const camera = game.camera.camera
  if (camera) {
    camera.layers = [...camera.layers, layer.id]
  }
  const lights = game.app.root
    .findComponents('light')
    .filter((light) => light.layers.includes(world.id))
  for (const light of lights) {
    light.layers = [...light.layers, layer.id]
  }
  return {
    layer,
    dispose() {
      for (const light of lights) {
        light.layers = light.layers.filter((id) => id !== layer.id)
      }
      if (camera) {
        camera.layers = camera.layers.filter((id) => id !== layer.id)
      }
      layers.removeOpaque(layer)
      layers.removeTransparent(layer)
    },
  }
}

export class FirstPersonModel {
  private readonly game: GameApplication
  private readonly rig: Entity
  private readonly layer: ReturnType<typeof viewmodelLayer>
  private current: Arms | undefined
  private desired: FirstPersonRequest | undefined
  private pending: Promise<void> | undefined
  private closed = false as boolean
  private failure: string | undefined
  private readonly urls = new Map<string, number>()
  private masked: Entity | undefined
  private readonly masks = new Map<MeshInstance, number>()
  private life: number | undefined
  private readonly motion = new ViewmodelMotion()
  private readonly sights = sightState()
  private sight: Sight = RESTING_SIGHT
  private readonly sightPosition = new Vec3()
  private readonly sightRotation = new Quat()
  private sighted = false as boolean
  constructor(game: GameApplication) {
    this.game = game
    this.layer = viewmodelLayer(game)
    this.rig = new Entity('viewmodel-rig', game.app)
    game.stage.addChild(this.rig)
  }
  get failed(): boolean {
    return Boolean(this.failure)
  }
  /** Arms are presented with sight landmarks for the held weapon. */
  get ready(): boolean {
    const arms = this.current
    return Boolean(
      arms?.actor.root.enabled &&
        this.desired &&
        armsKey(this.desired) === arms.key &&
        arms.actor.muzzleSocket(),
    )
  }
  retry(): void {
    this.failure = undefined
  }
  async prepare(request: FirstPersonRequest): Promise<void> {
    this.desired = request
    await this.load(request)
  }
  private lease(url: string, delta: number): void {
    const users = (this.urls.get(url) ?? 0) + delta
    if (users > 0) {
      this.urls.set(url, users)
    } else {
      this.urls.delete(url)
      this.game.releaseContainer(url)
    }
  }
  private release(arms: Arms): void {
    arms.actor.destroy()
    this.lease(arms.url, -1)
  }
  private load(request: FirstPersonRequest): Promise<void> | undefined {
    const key = armsKey(request)
    if (this.closed || this.pending || this.current?.key === key || this.failure === key) {
      return this.pending
    }
    const asset = VIEWMODELS[fitId(request.appearance?.loadout ?? DEFAULT_LOADOUT)]
    if (!asset) {
      this.failure = key
      return undefined
    }
    this.lease(asset.url, 1)
    this.pending = this.build(request, key, asset.url).finally(() => {
      this.pending = undefined
    })
    return this.pending
  }
  private async build(request: FirstPersonRequest, key: string, url: string): Promise<void> {
    let actor: DuelActor | undefined
    try {
      actor = await equippedActor(
        this.game,
        request.appearance?.loadout ?? DEFAULT_LOADOUT,
        request.appearance?.dyes ?? {},
        { viewmodel: { url } },
      )
      const created = actor
      await Promise.all(
        (['rifle', 'shotgun'] as const).map((weapon) =>
          attachHeldWeapon(
            this.game,
            created,
            weapon,
            `/experiments/out-west/3d/native-v2/dynamic/held-${weapon}.glb?v=${CONTENT_VERSION}`,
          ),
        ),
      )
      const pose = createRiderPose(this.game, actor)
      const arms: Arms = {
        key,
        url,
        actor,
        pose,
        clip: '',
        aim: pose.aim,
        weaponLayer: pose.weapon,
        firingUntil: 0,
        head: actor.model.findByName('Head'),
      }
      actor.root.tags.add(`viewmodel:${request.id}`)
      actor.root.reparent(this.rig)
      for (const render of actor.root.findComponents('render')) {
        render.castShadows = false
        render.layers = [this.layer.layer.id]
      }
      const desired = this.desired
      if (this.closed || !desired || armsKey(desired) !== key) {
        this.release(arms)
        return
      }
      // Settle the candidate's native pose before it can replace working arms.
      actor.hold(heldWeapon(desired.domain), true)
      animateRider(arms, desired.player, { first: true, domain: desired.domain })
      actor.model.anim?.update(0)
      pose.root.anim?.update(0)
      const previous = this.current
      this.current = arms
      this.failure = undefined
      this.sighted = false
      if (previous) {
        actor.root.enabled = previous.actor.root.enabled
        this.release(previous)
      }
    } catch {
      actor?.destroy()
      this.lease(url, -1)
      if (this.desired && armsKey(this.desired) === key) {
        this.failure = key
      }
    }
  }
  private restoreWorld(): void {
    for (const [instance, mask] of this.masks) {
      instance.shaderPassMask = mask
    }
    this.masks.clear()
    this.masked = undefined
  }
  /** Omit only the forward color pass; the physical rider keeps casting its animated shadow. */
  private maskWorld(root: Entity): void {
    if (this.masked !== root) {
      this.restoreWorld()
      this.masked = root
    }
    for (const render of root.findComponents('render')) {
      for (const instance of render.meshInstances) {
        if (!this.masks.has(instance)) {
          this.masks.set(instance, instance.shaderPassMask)
          instance.shaderPassMask &= ~(1 << SHADER_FORWARD)
        }
      }
    }
  }
  private hide(): void {
    this.restoreWorld()
    if (this.current) {
      this.current.actor.root.enabled = false
    }
    this.sighted = false
  }
  /** Selects native clips and load state; `present` places the arms after the camera. */
  update(request: FirstPersonRequest | undefined): void {
    this.desired = request
    if (!request || request.player.hp <= 0) {
      this.hide()
      return
    }
    void this.load(request)
    this.maskWorld(request.world.root)
    const arms = this.current
    if (!arms) {
      return
    }
    const life = request.domain?.spawnTick
    if (life !== this.life) {
      this.life = life
      arms.firingUntil = 0
      this.motion.reset()
      this.sighted = false
    }
    arms.actor.root.enabled = true
    arms.actor.hold(heldWeapon(request.domain), true)
    animateRider(arms, request.player, { first: true, domain: request.domain })
  }
  /** Steps the eased sight amount; zero until the arms show the held weapon's landmarks. */
  aim(intent: Pick<PlayerInput, 'buttons'>, active: boolean, dt: number): void {
    const domain = this.desired?.domain
    const held = heldWeapon(domain)
    const amount = advanceSights(
      this.sights,
      { active, ready: this.ready, intent, held, player: domain },
      dt,
    )
    this.sight = { held, amount }
  }
  /** Camera-relative placement: hip/sight blend, sway, bob, landing and recoil springs. */
  present(camera: Entity, dt: number): void {
    const sight = this.sight.amount
    const arms = this.current
    const request = this.desired
    if (!(arms?.actor.root.enabled && request) || dt <= 0) {
      return
    }
    const step = Math.min(dt, 0.1)
    const { player, domain } = request
    const held = heldWeapon(domain)
    const lens = camera.camera
    if (lens) {
      lens.fov = sightFov(lens.fov, this.sight)
    }
    const device = this.game.app.graphicsDevice
    const aspect = device.width / Math.max(1, device.height)
    const minor = Math.min(1, aspect)
    const worldTan = Math.tan(((lens?.fov ?? 70) * math.DEG_TO_RAD) / 2) * minor
    const shape = aspect < 1 ? 'portrait' : 'landscape'
    const modelFov = math.lerp(VIEWMODEL_FOV[shape], SIGHTED_FOV[shape], sight)
    const modelTan = Math.tan((modelFov * math.DEG_TO_RAD) / 2)
    const scale = worldTan / modelTan
    this.rig.setPosition(camera.getPosition())
    this.rig.setRotation(camera.getRotation())
    this.rig.setLocalScale(scale, scale, 1)
    const root = arms.actor.root
    inverseRoot.copy(root.getWorldTransform()).invert()
    // Hip: the authored eye (ten centimetres above Head) sits at the physical camera eye.
    if (arms.head) {
      local.mul2(inverseRoot, arms.head.getWorldTransform()).getTranslation(eye)
      eye.y += 0.1
    } else {
      eye.set(0, 1.62, 0)
    }
    hipRotation.copy(facing)
    hipRotation.transformVector(eye, hipPosition).mulScalar(-1).add(HIP[held])
    this.align(arms, held, sight, step)
    targetRotation.slerp(hipRotation, this.sightRotation, sight)
    targetPosition.lerp(hipPosition, this.sightPosition, sight)
    this.motion.apply({ player, domain, held, sight, dt: step }, targetPosition, targetRotation)
    root.setLocalPosition(targetPosition)
    root.setLocalRotation(targetRotation)
  }
  /** Sight landmarks on the view axis; held through each shot so the authored kick reads. */
  private align(arms: Arms, held: HeldWeapon, sight: number, dt: number): void {
    const profile = SIGHTS.get(held)
    const socket = arms.actor.muzzleSocket()
    if (!(profile && socket) || sight <= 0) {
      this.sighted = false
      return
    }
    if (this.sighted && performance.now() < arms.firingUntil) {
      return
    }
    local.mul2(inverseRoot, socket.getWorldTransform())
    local.transformPoint(profile.front, front)
    local.transformPoint(profile.rear, rear)
    along.sub2(front, rear).normalize()
    local.transformVector(Vec3.UP, up)
    side.cross(along, up).normalize()
    up.cross(side, along).normalize()
    // Columns map camera X/Y/Z to the root's side/up/back directions; invert for root-to-camera.
    const m = basis.data
    m[0] = side.x
    m[1] = side.y
    m[2] = side.z
    m[4] = up.x
    m[5] = up.y
    m[6] = up.z
    m[8] = -along.x
    m[9] = -along.y
    m[10] = -along.z
    targetRotation.setFromMat4(basis).invert()
    targetRotation.transformVector(rear, targetPosition)
    targetPosition.set(-targetPosition.x, -targetPosition.y, -profile.relief - targetPosition.z)
    // Ease back onto the sight line only while recovering from a held shot pose.
    if (this.sighted && performance.now() < arms.firingUntil + 160) {
      const blend = 1 - Math.exp(-dt * 30)
      this.sightRotation.slerp(this.sightRotation, targetRotation, blend)
      this.sightPosition.lerp(this.sightPosition, targetPosition, blend)
    } else {
      this.sightRotation.copy(targetRotation)
      this.sightPosition.copy(targetPosition)
      this.sighted = true
    }
  }
  muzzle(id: string): ReturnType<DuelActor['muzzle']> {
    return this.current?.actor.root.enabled && this.desired?.id === id
      ? this.current.actor.muzzle()
      : null
  }
  fire(id: string, crouched: boolean): void {
    const arms = this.current
    if (!arms?.actor.root.enabled || this.desired?.id !== id) {
      return
    }
    arms.firingUntil = performance.now() + RECOIL_SECONDS * 1000
    arms.actor.fireWeapon()
    const clip = arms.actor.shotClip(crouched)
    if (arms.weaponLayer.states.includes(clip)) {
      arms.weaponLayer.play(clip)
      arms.pose.root.anim?.update(0)
    }
    this.motion.kick(heldWeapon(this.desired.domain))
  }
  stats(): { arms: number; pending: number; masked: number } {
    return {
      arms: this.rig.children.length,
      pending: this.pending ? 1 : 0,
      masked: this.masks.size,
    }
  }
  destroy(): void {
    this.closed = true
    this.desired = undefined
    this.restoreWorld()
    if (this.current) {
      this.release(this.current)
      this.current = undefined
    }
    this.rig.destroy()
    this.layer.dispose()
  }
}
