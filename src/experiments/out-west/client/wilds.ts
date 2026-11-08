import { BLEND_NORMAL, Curve, CurveSet, Entity, type Texture, Vec3 } from 'playcanvas'
import { AMBIENT_ASSETS } from '../content/ambient.ts'
import { DuelActor } from '../duel/native-actor.ts'
import type { GameApplication } from './application.ts'

/** Authored rolling paths plus bounded native particle emitters for airborne desert dust. */
export class NativeWilds {
  private readonly game: GameApplication
  private readonly rollers: DuelActor
  private readonly motes: Entity
  private readonly devil: Entity
  private time = 0
  private disposed = false as boolean
  private constructor(game: GameApplication, rollers: DuelActor, texture: Texture) {
    this.game = game
    this.rollers = rollers
    this.motes = new Entity('airborne-dust', game.app)
    this.motes.addComponent('particlesystem', {
      numParticles: 72,
      lifetime: 6,
      rate: 0.08,
      loop: true,
      preWarm: true,
      emitterExtents: new Vec3(20, 3, 20),
      colorMap: texture,
      lighting: false,
      blendType: BLEND_NORMAL,
      depthWrite: false,
      useFog: true,
      localVelocityGraph: new CurveSet([0, 0.5, 1, 0.8], [0, 0.08, 1, 0.02], [0, 0.2, 1, 0.35]),
      colorGraph: new CurveSet([0, 0.72, 1, 0.72], [0, 0.57, 1, 0.57], [0, 0.37, 1, 0.37]),
      alphaGraph: new Curve([0, 0, 0.15, 0.16, 0.8, 0.1, 1, 0]),
      scaleGraph: new Curve([0, 0.04, 1, 0.09]),
      rotationSpeedGraph: new Curve([0, 15, 1, 30]),
    })
    this.devil = new Entity('distant-dust-devil', game.app)
    this.devil.addComponent('particlesystem', {
      numParticles: 48,
      lifetime: 3,
      rate: 0.065,
      loop: true,
      preWarm: true,
      emitterExtents: new Vec3(0.6, 0.05, 0.6),
      colorMap: texture,
      lighting: false,
      blendType: BLEND_NORMAL,
      depthWrite: false,
      useFog: true,
      localVelocityGraph: new CurveSet(
        [0, 0.6, 0.25, -0.65, 0.5, 0.6, 0.75, -0.65, 1, 0.6],
        [0, 1.15, 1, 1.35],
        [0, -0.6, 0.25, 0.6, 0.5, -0.6, 0.75, 0.6, 1, -0.6],
      ),
      colorGraph: new CurveSet([0, 0.65, 1, 0.76], [0, 0.47, 1, 0.6], [0, 0.29, 1, 0.43]),
      alphaGraph: new Curve([0, 0, 0.15, 0.22, 0.65, 0.15, 1, 0]),
      scaleGraph: new Curve([0, 0.22, 0.6, 0.6, 1, 0.9]),
      rotationSpeedGraph: new Curve([0, 45, 1, 100]),
    })
    game.stage.addChild(this.motes)
    game.stage.addChild(this.devil)
    game.app.on('update', this.update)
  }
  static async create(game: GameApplication, mode: 'frontier' | 'duel'): Promise<NativeWilds> {
    const source =
      mode === 'frontier'
        ? AMBIENT_ASSETS['frontier-tumbleweeds']
        : AMBIENT_ASSETS['duel-tumbleweeds']
    const [rollers, dust] = await Promise.all([
      DuelActor.create(game, source.url, `${mode}-rolling-tumbleweeds`),
      game.loadTexture(AMBIENT_ASSETS.dust.url, { srgb: true, flipY: false }),
    ])
    return new NativeWilds(game, rollers, dust.resource as Texture)
  }
  private readonly update = (dt: number): void => {
    this.time += dt
    const camera = this.game.camera.getPosition()
    this.motes.setPosition(camera.x, Math.max(1, camera.y), camera.z)
    this.devil.setPosition(camera.x + Math.sin(this.time * 0.08) * 6 - 10, 0, camera.z + 28)
  }
  destroy(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.game.app.off('update', this.update)
    this.rollers.destroy()
    this.motes.destroy()
    this.devil.destroy()
  }
}
