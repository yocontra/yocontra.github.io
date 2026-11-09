import {
  BLEND_ADDITIVEALPHA,
  BLEND_NORMAL,
  Color,
  CULLFACE_NONE,
  Curve,
  CurveSet,
  Entity,
  StandardMaterial,
  type Texture,
  Vec3,
} from 'playcanvas'
import { AMBIENT_ASSETS } from '../content/ambient.ts'
import type { GameApplication } from './application.ts'

const flashTextureUrl = new URL('./muzzle-flash.png', import.meta.url).href
const streakTextureUrl = new URL('./shot-streak.png', import.meta.url).href

export interface ShotPoint {
  x: number
  y: number
  z: number
}
export interface ShotTrace {
  readonly index: number
  readonly generation: number
}
interface Tracer {
  entity: Entity
  from: Vec3
  to: Vec3
  direction: Vec3
  distance: number
  age: number
  active: boolean
  generation: number
  fresh: boolean
}
interface Burst {
  entity: Entity
  mesh: Entity
  age: number
  duration: number
  size: number
  fresh: boolean
}
interface Smoke {
  entity: Entity
  age: number
}
const BULLET_SPEED = 260
const TRACE_LENGTH = 0.45
const applications = new WeakMap<GameApplication, ShotVisuals>()

/** One application-owned native visual pool serves both Frontier and cinematic Duel shots. */
export function shotVisuals(game: GameApplication, cinematic = false): ShotVisuals {
  let visuals = applications.get(game)
  if (!visuals) {
    visuals = new ShotVisuals(game, cinematic)
    applications.set(game, visuals)
  }
  return visuals
}

export class ShotVisuals {
  private readonly game: GameApplication
  private readonly material = new StandardMaterial()
  private readonly surfaceMaterial = new StandardMaterial()
  private readonly hitMaterial = new StandardMaterial()
  private readonly flashMaterial = new StandardMaterial()
  private readonly tracers: Tracer[] = []
  private readonly bursts: Burst[] = []
  private readonly smoke: Smoke[] = []
  private readonly light: Entity | undefined
  private readonly facing = new Vec3()
  private smokeTexture: Texture | undefined
  private lightFresh = false as boolean
  private closed = false as boolean
  private warming = false as boolean
  readonly ready: Promise<void>
  constructor(game: GameApplication, cinematic: boolean) {
    this.game = game
    this.material.diffuse = Color.BLACK
    this.material.emissive = new Color(1, 0.91, 0.72)
    this.material.useLighting = false
    this.material.blendType = BLEND_ADDITIVEALPHA
    this.material.opacityMapChannel = 'a'
    this.material.opacity = 0.7
    this.material.depthWrite = false
    this.material.cull = CULLFACE_NONE
    this.material.update()
    this.surfaceMaterial.diffuse = new Color(0.62, 0.54, 0.42)
    this.hitMaterial.diffuse = new Color(0.35, 0.08, 0.05)
    for (const material of [this.surfaceMaterial, this.hitMaterial]) {
      material.useLighting = false
      material.blendType = BLEND_NORMAL
      material.opacityMapChannel = 'a'
      material.opacity = 0.8
      material.depthWrite = false
      material.cull = CULLFACE_NONE
      material.update()
    }
    this.flashMaterial.diffuse = Color.BLACK
    this.flashMaterial.emissive = Color.WHITE
    this.flashMaterial.emissiveIntensity = 2
    this.flashMaterial.useLighting = false
    this.flashMaterial.blendType = BLEND_ADDITIVEALPHA
    this.flashMaterial.opacityMapChannel = 'a'
    this.flashMaterial.depthWrite = false
    this.flashMaterial.cull = CULLFACE_NONE
    if (cinematic) {
      this.light = new Entity('gun-flash-light', game.app)
      this.light.addComponent('light', {
        type: 'point',
        color: new Color(1, 0.72, 0.34),
        intensity: 0,
        range: 6,
        castShadows: false,
      })
      game.stage.addChild(this.light)
    }
    const flash = game.loadTexture(flashTextureUrl, { srgb: true, flipY: false }).then((asset) => {
      if (!this.closed) {
        this.flashMaterial.emissiveMap = asset.resource as Texture
        this.flashMaterial.opacityMap = asset.resource as Texture
        this.flashMaterial.update()
      }
    })
    const dust = game
      .loadTexture(AMBIENT_ASSETS.dust.url, { srgb: true, flipY: false })
      .then((asset) => {
        if (!this.closed) {
          const texture = asset.resource as Texture
          for (const material of [this.surfaceMaterial, this.hitMaterial]) {
            material.opacityMap = texture
            material.update()
          }
          if (cinematic) {
            this.smokeTexture = texture
          }
        }
      })
    const streak = game
      .loadTexture(streakTextureUrl, { srgb: true, flipY: false })
      .then((asset) => {
        if (!this.closed) {
          this.material.opacityMap = asset.resource as Texture
          this.material.update()
        }
      })
    this.ready = Promise.all([flash, dust, streak]).then(() => undefined)
    game.app.on('update', this.update)
    game.app.on('postrender', this.rendered)
    game.app.once('destroy', () => this.destroy())
  }
  trace(from: ShotPoint, to: ShotPoint): ShotTrace | undefined {
    if (this.closed) {
      return undefined
    }
    let index = this.tracers.findIndex((entry) => !entry.active)
    if (index < 0) {
      if (this.tracers.length >= 48) {
        return undefined
      }
      const entity = new Entity('bullet-trace', this.game.app)
      entity.addComponent('render', {
        type: 'plane',
        material: this.material,
        castShadows: false,
        receiveShadows: false,
      })
      this.game.stage.addChild(entity)
      index = this.tracers.length
      this.tracers.push({
        entity,
        from: new Vec3(),
        to: new Vec3(),
        direction: new Vec3(),
        distance: 0,
        age: 0,
        active: false,
        generation: 0,
        fresh: true,
      })
    }
    const tracer = this.tracers[index]
    if (!tracer) {
      return undefined
    }
    tracer.from.set(from.x, from.y, from.z)
    tracer.to.set(to.x, to.y, to.z)
    tracer.age = 0
    tracer.generation++
    tracer.active = true
    tracer.fresh = true
    tracer.entity.enabled = true
    ShotVisuals.aim(tracer)
    this.move(tracer)
    return { index, generation: tracer.generation }
  }
  retarget(handle: ShotTrace | undefined, to: ShotPoint): void {
    const tracer = handle ? this.tracers[handle.index] : undefined
    if (tracer?.active && tracer.generation === handle?.generation) {
      tracer.to.set(to.x, to.y, to.z)
      ShotVisuals.aim(tracer)
      this.move(tracer)
    }
  }
  muzzle(at: ShotPoint, size = 0.09, direction?: Vec3): void {
    if (this.closed) {
      return
    }
    this.burst('muzzle-flash', at, 0.035, size)
    if (this.light?.light) {
      this.light.setPosition(
        at.x + (direction?.x ?? 0) * 0.75,
        at.y + (direction?.y ?? 0) * 0.75,
        at.z + (direction?.z ?? 0) * 0.75,
      )
      this.light.light.intensity = 5
      this.lightFresh = true
    }
    if (this.smokeTexture) {
      this.emitSmoke(at, this.smokeTexture)
    }
  }
  impact(at: ShotPoint, hit: boolean): void {
    this.burst(hit ? 'bullet-hit' : 'bullet-impact', at, 0.16, hit ? 0.09 : 0.12)
  }
  private emitSmoke(at: ShotPoint, texture: Texture): void {
    let smoke = this.smoke.find((entry) => entry.age >= 1)
    if (!smoke) {
      if (this.smoke.length >= 3) {
        return
      }
      const entity = new Entity('gun-smoke', this.game.app)
      entity.enabled = false
      entity.addComponent('particlesystem', {
        numParticles: 10,
        lifetime: 0.7,
        rate: 0.012,
        loop: false,
        autoPlay: false,
        colorMap: texture,
        blendType: BLEND_NORMAL,
        lighting: false,
        depthWrite: false,
        emitterExtents: new Vec3(0.025, 0.025, 0.025),
        localVelocityGraph: new CurveSet(
          [0, -0.08, 1, 0.08],
          [0, 0.25, 1, 0.6],
          [0, -0.08, 1, 0.08],
        ),
        colorGraph: new CurveSet([0, 0.7, 1, 0.7], [0, 0.67, 1, 0.67], [0, 0.63, 1, 0.63]),
        alphaGraph: new Curve([0, 0, 0.1, 0.3, 1, 0]),
        scaleGraph: new Curve([0, 0.03, 1, 0.18]),
      })
      this.game.stage.addChild(entity)
      smoke = { entity, age: 1 }
      this.smoke.push(smoke)
    }
    smoke.entity.setPosition(at.x, at.y, at.z)
    smoke.entity.enabled = true
    smoke.entity.particlesystem?.reset()
    smoke.entity.particlesystem?.play()
    smoke.age = 0
  }
  private static aim(tracer: Tracer): void {
    tracer.direction.sub2(tracer.to, tracer.from)
    tracer.distance = tracer.direction.length()
    tracer.direction.normalize()
    tracer.entity.lookAt(tracer.to)
  }
  private move(tracer: Tracer): void {
    const head = Math.min(tracer.distance, 0.12 + tracer.age * BULLET_SPEED)
    const tail = Math.max(0, head - TRACE_LENGTH)
    const center = (head + tail) / 2
    tracer.entity.setPosition(
      tracer.from.x + tracer.direction.x * center,
      tracer.from.y + tracer.direction.y * center,
      tracer.from.z + tracer.direction.z * center,
    )
    this.facing.sub2(this.game.camera.getPosition(), tracer.entity.getPosition())
    tracer.entity.lookAt(tracer.to, this.facing)
    tracer.entity.setLocalScale(0.0045, 1, Math.max(0.001, head - tail))
    const fade = Math.max(0, 1 - tracer.age / Math.max(0.025, tracer.distance / BULLET_SPEED))
    for (const mesh of tracer.entity.render?.meshInstances ?? []) {
      mesh.setParameter('material_opacity', 0.7 * fade)
    }
  }
  private burst(name: string, at: ShotPoint, duration: number, size: number): void {
    if (this.closed) {
      return
    }
    let effect = this.bursts.find(
      (entry) => entry.entity.name === name && entry.age >= entry.duration,
    )
    if (!effect) {
      if (this.bursts.length >= 24) {
        return
      }
      const entity = new Entity(name, this.game.app)
      const flash = name === 'muzzle-flash'
      let material = name === 'bullet-hit' ? this.hitMaterial : this.surfaceMaterial
      if (flash) {
        material = this.flashMaterial
      }
      const mesh = new Entity(flash ? 'flash-star' : 'impact-puff', this.game.app)
      entity.addChild(mesh)
      mesh.setLocalEulerAngles(90, 0, 0)
      if (!flash) {
        mesh.setLocalPosition(0, 0, -0.003)
      }
      mesh.addComponent('render', {
        type: 'plane',
        material,
        castShadows: false,
        receiveShadows: false,
      })
      this.game.stage.addChild(entity)
      effect = { entity, mesh, age: 0, duration, size, fresh: true }
      this.bursts.push(effect)
    }
    effect.entity.enabled = true
    effect.entity.setPosition(at.x, at.y, at.z)
    effect.entity.lookAt(this.game.camera.getPosition())
    for (const mesh of effect.mesh.render?.meshInstances ?? []) {
      mesh.setParameter('material_opacity', name === 'muzzle-flash' ? 1 : 0.8)
    }
    effect.entity.setLocalScale(size, size, size)
    effect.age = 0
    effect.duration = duration
    effect.size = size
    effect.fresh = true
  }
  private readonly update = (dt: number): void => {
    if (this.warming) {
      return
    }
    for (const tracer of this.tracers) {
      if (!tracer.active || tracer.fresh) {
        continue
      }
      tracer.age += dt
      if (tracer.age * BULLET_SPEED > tracer.distance + TRACE_LENGTH) {
        tracer.active = false
        tracer.entity.enabled = false
      } else {
        this.move(tracer)
      }
    }
    for (const effect of this.bursts) {
      if (effect.age >= effect.duration || effect.fresh) {
        continue
      }
      effect.age += dt
      effect.entity.enabled = effect.age < effect.duration
      const growth = effect.entity.name === 'muzzle-flash' ? -0.35 : 1
      const size = effect.size * (1 + (growth * effect.age) / effect.duration)
      effect.entity.setLocalScale(size, size, size)
      if (effect.entity.name !== 'muzzle-flash') {
        effect.entity.lookAt(this.game.camera.getPosition())
        for (const mesh of effect.mesh.render?.meshInstances ?? []) {
          mesh.setParameter('material_opacity', 0.8 * Math.max(0, 1 - effect.age / effect.duration))
        }
      }
    }
    for (const smoke of this.smoke) {
      smoke.age += dt
      if (smoke.age >= 1) {
        smoke.entity.enabled = false
      }
    }
    if (this.light?.light && !this.lightFresh) {
      this.light.light.intensity *= Math.exp(-dt * 25)
    }
  }
  private readonly rendered = (): void => {
    this.lightFresh = false
    for (const tracer of this.tracers) {
      tracer.fresh = false
    }
    for (const effect of this.bursts) {
      effect.fresh = false
    }
  }
  async warm(at: ShotPoint): Promise<void> {
    await this.ready
    if (this.closed) {
      return
    }
    this.warming = true
    this.muzzle(at)
    this.trace(at, { x: at.x, y: at.y, z: at.z - 1 })
    this.impact(at, false)
    this.impact(at, true)
    await new Promise<void>((resolve) => {
      const done = () => {
        this.game.app.off('postrender', done)
        this.game.app.off('destroy', done)
        resolve()
      }
      this.game.app.once('postrender', done)
      this.game.app.once('destroy', done)
    })
    this.warming = false
    if (!this.closed) {
      this.reset()
    }
  }
  reset(): void {
    for (const tracer of this.tracers) {
      tracer.active = false
      tracer.entity.enabled = false
      for (const mesh of tracer.entity.render?.meshInstances ?? []) {
        mesh.deleteParameter('material_opacity')
      }
    }
    for (const burst of this.bursts) {
      burst.age = burst.duration
      burst.entity.enabled = false
      for (const mesh of burst.mesh.render?.meshInstances ?? []) {
        mesh.deleteParameter('material_opacity')
      }
    }
    for (const smoke of this.smoke) {
      smoke.age = 1
      smoke.entity.enabled = false
    }
    if (this.light?.light) {
      this.light.light.intensity = 0
    }
  }
  destroy(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.game.app.off('update', this.update)
    this.game.app.off('postrender', this.rendered)
    for (const tracer of this.tracers) {
      tracer.entity.destroy()
    }
    for (const burst of this.bursts) {
      burst.entity.destroy()
    }
    for (const smoke of this.smoke) {
      smoke.entity.destroy()
    }
    this.light?.destroy()
    this.tracers.length = 0
    this.bursts.length = 0
    this.smoke.length = 0
    this.material.destroy()
    this.surfaceMaterial.destroy()
    this.hitMaterial.destroy()
    this.flashMaterial.destroy()
  }
}
