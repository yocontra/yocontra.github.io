import { type Client, Room } from '@colyseus/core'
import { schema, t } from '@colyseus/schema'
import { FixedRoomClock } from 'durable-game-runtime/clock'
import { createPhysicsWorld } from 'durable-game-runtime/physics'
import { initializeWorkerAmmo } from 'durable-game-runtime/worker-physics'
import { Entity, Vec3 } from 'playcanvas'

const RoomState = schema({ tick: t.uint32(), heights: t.map('float32') }, 'DemoRoomState')
export const ROOM_NAME = 'falling-boxes'
export const MAX_CLIENTS = 4
const TICK_HZ = 20

export class PhysicsRoom extends Room<{ state: InstanceType<typeof RoomState> }> {
  override state = new RoomState()
  override maxClients = MAX_CLIENTS
  private world: ReturnType<typeof createPhysicsWorld> | undefined
  private readonly bodies = new Map<string, Entity>()

  override onCreate() {
    this.state.tick = 0
    this.clock.stop()
    this.clock = new FixedRoomClock(1000 / TICK_HZ)
    this.setFixedTimestep(() => undefined, TICK_HZ, { subSteps: 3 })
    this.setPatchRate(null)
    this.setTimestep()
    this.clock.stop()

    this.onMessage('hop', (client) => {
      this.bodies.get(client.sessionId)?.rigidbody?.applyImpulse(0, 4, 0)
    })
  }

  override async onJoin(client: Client) {
    const ammo = await initializeWorkerAmmo()
    if (Reflect.get(client.ref, 'readyState') !== 1) {
      throw new Error('Socket closed')
    }
    if (!this.world) {
      this.world = createPhysicsWorld({ ammo })
      const floor = new Entity('floor', this.world.app)
      floor.setPosition(0, -0.5, 0)
      floor.addComponent('collision', { type: 'box', halfExtents: new Vec3(10, 0.5, 10) })
      floor.addComponent('rigidbody', { type: 'static' })
      this.world.app.root.addChild(floor)
      this.clock.start()
      this.setFixedTimestep(() => this.advance(), TICK_HZ, { subSteps: 3 })
    }
    const box = new Entity(client.sessionId, this.world.app)
    const occupied = [...this.bodies.values()].map((body) => body.getPosition().x)
    const x =
      [0, 2, 4, 6].find((slot) => occupied.every((other) => Math.abs(slot - other) > 1)) ?? 0
    box.setPosition(x, 3, 0)
    box.addComponent('collision', { type: 'box', halfExtents: new Vec3(0.5, 0.5, 0.5) })
    box.addComponent('rigidbody', { type: 'dynamic', mass: 1 })
    this.world.app.root.addChild(box)
    this.bodies.set(client.sessionId, box)
    this.state.heights.set(client.sessionId, 3)
  }

  private advance() {
    if (!this.world) {
      return
    }
    for (let step = 0; step < 3; step++) {
      this.world.physics.step(1 / (TICK_HZ * 3))
    }
    this.state.tick++
    for (const [id, body] of this.bodies) {
      this.state.heights.set(id, body.getPosition().y)
    }
    this.broadcastPatch()
  }

  override onLeave(client: Client) {
    this.bodies.get(client.sessionId)?.destroy()
    this.bodies.delete(client.sessionId)
    this.state.heights.delete(client.sessionId)
    if (this.bodies.size === 0) {
      this.clearWorld()
    }
  }

  override onDispose() {
    this.clearWorld()
  }

  private clearWorld() {
    this.setTimestep()
    this.clock.stop()
    this.world?.app.destroy()
    this.world = undefined
    this.bodies.clear()
  }

  get active() {
    return this.world !== undefined
  }
}
