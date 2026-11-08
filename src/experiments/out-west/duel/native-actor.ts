import { type AnimTrack, type ContainerResource, Entity, type GraphNode } from 'playcanvas'
import type { GameApplication } from '../client/application.ts'

const ONE_SHOT = /Death|Shoot|Hit|Attack|React/u
const DRAWN = /Pointing|Shoot|Death|Hit/u

/** The engine owns skeletal playback; duel logic requests named authored clips. */
export class DuelActor {
  private current = ''
  readonly weaponMounts: { node: GraphNode; drawn: boolean }[] = []
  readonly root: Entity
  readonly model: Entity
  private constructor(root: Entity, model: Entity) {
    this.root = root
    this.model = model
  }

  static async create(game: GameApplication, url: string, name: string): Promise<DuelActor> {
    const asset = await game.loadContainer(url)
    const resource = asset.resource as ContainerResource
    const model = resource.instantiateRenderEntity({ castShadows: true, receiveShadows: true })
    const root = new Entity(name, game.app)
    root.addChild(model)
    game.stage.addChild(root)
    const tracks = resource.animations.map((clip) => clip.resource as AnimTrack).filter(Boolean)
    model.addComponent('anim', { activate: true })
    model.anim?.loadStateGraph({
      layers: [
        {
          name: 'Duel',
          states: [
            { name: 'START' },
            ...tracks.map((track) => ({
              name: track.name,
              speed: 1,
              loop: !ONE_SHOT.test(track.name),
            })),
          ],
          transitions: [{ from: 'START', to: 'Idle' }],
        },
      ],
      parameters: {},
    })
    for (const track of tracks) {
      model.anim?.baseLayer?.assignAnimation(track.name, track)
    }
    const actor = new DuelActor(root, model)
    actor.play('Idle')
    return actor
  }
  play(name: string, seconds = 0.12): void {
    const drawn = DRAWN.test(name)
    for (const mount of this.weaponMounts) {
      mount.node.enabled = mount.drawn === drawn
    }
    if (name === this.current) {
      if (ONE_SHOT.test(name)) {
        this.model.anim?.baseLayer?.play(name)
      }
      return
    }
    this.model.anim?.baseLayer?.transition(name, seconds)
    this.current = name
  }
  face(degrees: number): void {
    this.root.setEulerAngles(0, degrees, 0)
  }
  place(x: number, y: number, z: number): void {
    this.root.setPosition(x, y, z)
  }
  destroy(): void {
    this.root.destroy()
  }
}
