import { type AnimTrack, type ContainerResource, Entity, Vec3 } from 'playcanvas'
import type { GameApplication } from '../client/application.ts'
import { ASSETS } from '../content/manifest.ts'
import { nativeActionSpeed } from '../scene/native-animation-timing.ts'
import { type DetachedAttachment, detachAttachment } from '../scene/native-attachments.ts'
import { prepareNativeMaterials } from '../scene/native-materials.ts'
import { authoredMounts, type WeaponMount } from '../scene/native-mounts.ts'
import { animateRevolvers, playWeaponMount } from '../scene/native-weapon-animation.ts'

const ONE_SHOT = /Death|Shoot|Hit|Attack|React|Draw|Flinch|Spin/u
const HUMANOID = /\/(?:baked\/(?:outlaw-|player)|equipment\/outfit\.)/u
const GAIT = /^(?:Stride_|Walk$|Run$|Sprint$|Crouch_Walk$)/u
const DRAWN = /Pointing|Shoot|Death|Hit|Draw|Spin|Flinch/u

/** The engine owns skeletal playback; duel logic requests named authored clips. */
export class DuelActor {
  private current = ''
  private idleClip = 'Idle_Character'
  paired = false as boolean
  readonly weaponMounts: WeaponMount[] = []
  readonly tracks: readonly AnimTrack[]
  private readonly animations: ReadonlyMap<string, AnimTrack>
  private readonly detached = new Map<Entity, DetachedAttachment>()
  private readonly bonePaths = new Map<string, Set<string>>()
  private held: 'revolver' | 'rifle' | 'shotgun' = 'revolver'
  private carryDrawn = false as boolean
  walkSpeed = 1.13
  gaitSpeeds: Record<string, number> = {}
  private playbackRate = 1
  readonly root: Entity
  readonly model: Entity
  private constructor(root: Entity, model: Entity, animations: ReadonlyMap<string, AnimTrack>) {
    root.once('destroy', () => this.clearDetached())
    this.root = root
    this.model = model
    this.animations = animations
    this.tracks = [...animations.values()]
    for (const track of this.tracks) {
      for (const curve of track.curves) {
        for (const path of curve.paths) {
          const bone = path.entityPath.at(-1)
          if (!bone) {
            continue
          }
          const paths = this.bonePaths.get(bone) ?? new Set<string>()
          paths.add(path.entityPath.join('/'))
          this.bonePaths.set(bone, paths)
        }
      }
    }
  }
  hasAnimation(name: string): boolean {
    return this.animations.has(name)
  }
  animationTrack(name: string): AnimTrack | undefined {
    return this.animations.get(name)
  }

  static async create(game: GameApplication, url: string, name: string): Promise<DuelActor> {
    const asset = await game.loadContainer(url)
    const resource = asset.resource as ContainerResource
    const tracks = resource.animations
      .map((clip) => clip.resource as AnimTrack)
      .filter((track) => track && !track.name.startsWith('Weapon_'))
    const indexed = new Map(tracks.map((track) => [track.name, track]))
    if (HUMANOID.test(url)) {
      const moves = (await game.loadContainer(ASSETS.moves.url)).resource as ContainerResource
      for (const clip of moves.animations) {
        const track = clip.resource as AnimTrack
        if (track && !indexed.has(track.name)) {
          tracks.push(track)
          indexed.set(track.name, track)
        }
      }
    }
    const releaseMaterials = await prepareNativeMaterials(game, resource)
    if (!game.stage.parent) {
      releaseMaterials()
      throw new DOMException('Game was closed', 'AbortError')
    }
    let created: Entity | undefined
    try {
      const model = resource.instantiateRenderEntity({ castShadows: true, receiveShadows: true })
      const root = new Entity(name, game.app)
      created = root
      root.addChild(model)
      root.once('destroy', releaseMaterials)
      game.stage.addChild(root)
      const initial = indexed.get('Idle')?.name ?? tracks[0]?.name
      if (initial) {
        model.addComponent('anim', { activate: false })
        model.anim?.loadStateGraph({
          layers: [
            {
              name: 'Duel',
              states: [
                { name: 'START' },
                ...tracks.map((track) => ({
                  name: track.name,
                  speed: HUMANOID.test(url) ? nativeActionSpeed(track) : 1,
                  loop: !ONE_SHOT.test(track.name),
                })),
              ],
              transitions: [{ from: 'START', to: initial }],
            },
          ],
          parameters: {},
        })
        for (const track of tracks) {
          model.anim?.baseLayer?.assignAnimation(track.name, track)
        }
        model.anim?.baseLayer?.play(initial)
        if (model.anim) {
          model.anim.activate = true
          model.anim.playing = true
        }
      }
      const actor = new DuelActor(root, model, indexed)
      if (HUMANOID.test(url)) {
        const moves = (await game.loadContainer(ASSETS.moves.url)).resource as ContainerResource
        actor.gaitSpeeds =
          (
            moves as ContainerResource & {
              data: { gltf?: { extras?: { gaitSpeeds?: Record<string, number> } } }
            }
          ).data.gltf?.extras?.gaitSpeeds ?? {}
      }
      const metadata = (
        resource as ContainerResource & {
          data: { gltf?: { nodes?: { extras?: { paceLength?: number; walkDuration?: number } }[] } }
        }
      ).data.gltf?.nodes?.find((node) => node.extras?.paceLength)?.extras
      if (metadata?.paceLength && metadata.walkDuration) {
        actor.walkSpeed = (metadata.paceLength * 2) / metadata.walkDuration
      }
      for (const { node, point } of authoredMounts(model)) {
        if (point.mode === 'drawn' || point.mode === 'holstered') {
          actor.weaponMounts.push({ node, drawn: point.mode === 'drawn', hand: point.hand })
        }
      }
      animateRevolvers(actor.weaponMounts, resource)
      actor.paired = actor.weaponMounts.some((mount) => mount.drawn && mount.hand === 'L')
      actor.play('Idle')
      return actor
    } catch (error) {
      created?.destroy()
      releaseMaterials()
      throw error
    }
  }
  play(requested: string, seconds = 0.12): void {
    if (!this.model.anim) {
      return
    }
    let name = this.animation(requested)
    if (name === 'Idle' || name === 'Idle_Gun') {
      name = this.idleAnimation()
    }
    if (!this.model.anim.baseLayer?.states.includes(name)) {
      throw new Error(`Missing native animation ${name} on ${this.root.name}`)
    }
    if (this.model.anim && !GAIT.test(name)) {
      this.model.anim.speed = 1
      this.playbackRate = 1
    }
    this.showWeapon(name)
    const action = name.replace('_Pair', '')
    if (['Draw', 'Flinch', 'Spin'].includes(action)) {
      this.animateGuns(action)
    } else if ((requested === 'Idle' || requested === 'Idle_Gun') && name !== this.current) {
      this.animateGuns('Idle')
    }
    if (name === this.current) {
      if (ONE_SHOT.test(name)) {
        this.model.anim?.baseLayer?.play(name)
      }
      return
    }
    this.model.anim?.baseLayer?.transition(name, seconds)
    this.current = name
    if (seconds === 0) {
      this.model.anim?.update(0)
    }
  }
  shotClip(crouched = false): string {
    if (this.held === 'revolver') {
      return crouched ? 'Crouch_Gun_Shoot' : this.animation('Gun_Shoot')
    }
    const shot = `Shoot_${this.held}`
    if (crouched) {
      return `Crouch_${shot}`
    }
    return this.hasAnimation(shot) ? shot : `Hold_${this.held}`
  }
  private animateGuns(action: string): void {
    for (const mount of this.weaponMounts) {
      if (
        mount.drawn &&
        !mount.weapon &&
        mount.node instanceof Entity &&
        !this.detached.has(mount.node)
      ) {
        playWeaponMount(mount.node, action, mount.hand ?? 'R')
      }
    }
  }
  fireWeapon(): void {
    if (this.held === 'revolver') {
      this.animateGuns('Shoot')
      return
    }
    for (const mount of this.weaponMounts) {
      if (
        mount.weapon === this.held &&
        mount.node instanceof Entity &&
        !this.detached.has(mount.node)
      ) {
        playWeaponMount(mount.node, 'Shoot', this.held)
      }
    }
  }
  shoot(): void {
    this.play(this.shotClip(), 0)
    this.fireWeapon()
  }
  animation(name: string): string {
    const pair = `${name}_Pair`
    return this.paired && !this.carryDrawn && this.hasAnimation(pair) ? pair : name
  }
  idle(clip: string): void {
    this.idleClip = clip
  }
  private idleAnimation(): string {
    if (this.hasAnimation(this.idleClip)) {
      return this.idleClip
    }
    if (this.hasAnimation('Idle')) {
      return 'Idle'
    }
    return this.tracks[0]?.name ?? 'Idle'
  }
  upperBodyMask(children = true, rootBone = 'Abdomen'): Record<string, { children: boolean }> {
    return Object.fromEntries(
      [...(this.bonePaths.get(rootBone) ?? [])].map((path) => [path, { children }]),
    )
  }
  hold(weapon: 'revolver' | 'rifle' | 'shotgun', drawn = false): void {
    this.held = weapon
    this.carryDrawn = drawn
    this.showWeapon(this.current)
  }
  private showWeapon(name: string): void {
    const drawn = this.carryDrawn || DRAWN.test(name)
    for (const mount of this.weaponMounts) {
      if (mount.node instanceof Entity && this.detached.has(mount.node)) {
        continue
      }
      if (mount.weapon) {
        mount.node.enabled = mount.weapon === this.held
        continue
      }
      // Frontier carries only the right-hand revolver; Duel's authored paired draw uses both.
      const spare = this.carryDrawn && mount.hand === 'L'
      const showDrawn = this.held === 'revolver' && drawn && !spare
      mount.node.enabled = mount.drawn === showDrawn
    }
  }
  speed(value: number): void {
    const rate = Math.max(0.05, Math.min(8, value))
    if (this.playbackRate === rate) {
      return
    }
    if (this.model.anim) {
      this.model.anim.speed = rate
    }
    this.playbackRate = rate
  }

  muzzle(): { position: Vec3; direction: Vec3 } | null {
    const mounts = this.weaponMounts.filter(
      (mount) =>
        mount.node.enabled &&
        !(mount.node instanceof Entity && this.detached.has(mount.node)) &&
        (mount.weapon ? mount.weapon === this.held : mount.drawn),
    )
    const active =
      mounts.find((mount) => mount.weapon === this.held) ??
      mounts.find((mount) => mount.hand === 'R') ??
      mounts[0]
    const socket = active?.node.findByName('socket.muzzle')
    if (!socket?.enabled) {
      return null
    }
    // Revolvers are authored along +X. The socket follows the actual gun and wrist animation.
    const direction = socket.getWorldTransform().transformVector(Vec3.RIGHT, new Vec3()).normalize()
    return { position: socket.getPosition().clone(), direction }
  }
  face(degrees: number): void {
    this.root.setEulerAngles(0, degrees, 0)
  }
  place(x: number, y: number, z: number): void {
    this.root.setPosition(x, y, z)
  }
  detach(kind: 'hat' | 'gun'): Entity | null {
    const stage = this.root.parent
    if (!(stage instanceof Entity)) {
      return null
    }
    const mount =
      kind === 'hat'
        ? authoredMounts(this.root).find(
            ({ node, point }) =>
              point.bone === 'Head' && point.mode === 'accessory' && node.enabled,
          )?.node
        : this.weaponMounts.find(
            ({ node, weapon, drawn, hand }) =>
              node.enabled && (weapon ? weapon === this.held : drawn && hand !== 'L'),
          )?.node
    if (!(mount instanceof Entity) || this.detached.has(mount)) {
      return null
    }
    this.detached.set(mount, detachAttachment(mount, stage))
    return mount
  }
  restoreAttachments(): void {
    for (const attachment of this.detached.values()) {
      attachment.restore()
    }
    this.detached.clear()
    this.showWeapon(this.current)
  }
  private clearDetached(): void {
    for (const attachment of this.detached.values()) {
      attachment.destroy()
    }
    this.detached.clear()
  }
  destroy(): void {
    this.clearDetached()
    this.root.destroy()
  }
}
