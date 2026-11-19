import {
  AmmoPhysicsWorld,
  AppBase,
  AppOptions,
  CollisionComponentSystem,
  JointComponentSystem,
  NullGraphicsDevice,
  RigidBodyComponentSystem,
} from 'playcanvas'

export interface PhysicsWorldOptions {
  /** The shared module returned by initializeAmmo. */
  ammo: unknown
  /** Downward acceleration in m/s². Defaults to 9.81. */
  gravity?: number
  /** Register the PlayCanvas joint component system. */
  joints?: boolean
}

/** Create an unstarted PlayCanvas application with a room-owned Bullet world. */
export function createPhysicsWorld(options: PhysicsWorldOptions) {
  Object.assign(globalThis, { Ammo: options.ammo })
  const device = new NullGraphicsDevice({ width: 1, height: 1 })
  const app = new AppBase(device.canvas)
  const config = new AppOptions()
  config.graphicsDevice = device
  config.componentSystems = [RigidBodyComponentSystem, CollisionComponentSystem]
  if (options.joints) {
    config.componentSystems.push(JointComponentSystem)
  }
  config.physicsWorld = new AmmoPhysicsWorld()
  app.init(config)
  const physics = (() => {
    const system = app.systems.rigidbody
    if (!system) {
      app.destroy()
      throw new Error('PlayCanvas physics system unavailable')
    }
    return system
  })()
  physics.timeScale = 0
  // The shared runtime supplies exact 60 Hz substeps; disable Bullet's second accumulator.
  physics.maxSubSteps = 0
  physics.gravity.set(0, -(options.gravity ?? 9.81), 0)
  return { app, physics }
}
