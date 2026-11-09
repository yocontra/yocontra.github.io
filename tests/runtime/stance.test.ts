import { beforeAll, expect, it, spyOn } from 'bun:test'
import { file } from 'bun'
import { Entity } from 'playcanvas'
import { predictionInput } from '../../src/experiments/out-west/client/player-pose.ts'
import { ANGLE_SCALE, SHOT_WALL } from '../../src/experiments/out-west/contract/town.ts'
import { eyeHeight } from '../../src/experiments/out-west/ffa/sim/combat.ts'
import { TOWN } from '../../src/experiments/out-west/ffa/sim/layout.ts'
import { addPlayer } from '../../src/experiments/out-west/ffa/sim/world.ts'
import { initializeAmmo } from '../../src/experiments/out-west/runtime/ammo.ts'
import { createFrontierSimulation } from '../../src/experiments/out-west/runtime/frontier.ts'
import { Buttons, neutralInput } from '../../src/experiments/out-west/runtime/protocol.ts'
import { createSimulation } from '../../src/experiments/out-west/runtime/world.ts'

let ammo: unknown
beforeAll(async () => {
  ammo = await initializeAmmo(
    await WebAssembly.compile(
      await file('public/experiments/out-west/physics/ammo.wasm.wasm').arrayBuffer(),
    ),
  )
})
const floor = { center: [10, -0.5, 10] as const, halfExtents: [20, 0.5, 20] as const }

it('same-stance authoritative adopts retain the native body and floor contact', () => {
  const game = createSimulation({
    ammo,
    collision: { version: 'stance-adopt', boxes: [floor], meshes: [] },
  })
  try {
    const state = game.addPlayer('self', [10, 0.9, 10])
    for (let tick = 0; tick < 20; tick++) {
      game.step(new Map())
    }
    const entity = game.app.root.findByName('self')
    const physics = game.app.systems.rigidbody
    const collision = game.app.systems.collision
    if (
      !(entity instanceof Entity && entity.rigidbody && entity.collision && physics && collision)
    ) {
      throw new Error('Missing native body or collision system')
    }
    const body = entity.rigidbody.body
    const shape = entity.collision.shape
    const dispatcher = physics.dispatcher
    expect(dispatcher.getNumManifolds()).toBe(1)
    const contact = dispatcher.getManifoldByIndexInternal(0)
    expect(contact.getNumContacts()).toBeGreaterThan(0)
    const rebuild = spyOn(collision, 'recreatePhysicalShapes')
    try {
      for (let tick = 0; tick < 20; tick++) {
        game.adopt('self', structuredClone(state))
        game.step(new Map())
        expect(entity.rigidbody.body).toBe(body)
        expect(entity.collision.shape).toBe(shape)
        expect(dispatcher.getManifoldByIndexInternal(0)).toBe(contact)
        expect(contact.getNumContacts()).toBeGreaterThan(0)
      }
      expect(rebuild).not.toHaveBeenCalled()
      const standing = structuredClone(state)
      game.adopt('self', { ...standing, crouched: true })
      expect(entity.collision.height).toBe(1.2)
      expect(entity.collision.shape).not.toBe(shape)
      expect(entity.getPosition().y).toBeCloseTo(standing.y - 0.3, 4)
      expect(rebuild).toHaveBeenCalledTimes(1)
      const crouchedShape = entity.collision.shape
      for (let tick = 0; tick < 20; tick++) {
        game.adopt('self', structuredClone(state))
      }
      expect(entity.collision.shape).toBe(crouchedShape)
      expect(rebuild).toHaveBeenCalledTimes(1)
      game.adopt('self', standing)
      expect(entity.collision.height).toBe(1.8)
      expect(entity.getPosition().y).toBeCloseTo(standing.y, 4)
      expect(rebuild).toHaveBeenCalledTimes(2)
    } finally {
      rebuild.mockRestore()
    }
  } finally {
    game.dispose()
  }
})

it('blocked standing preserves native/domain crouch and shot height, then recovers outside cover and after restore', () => {
  const game = createFrontierSimulation({
    ammo,
    collision: {
      version: 'stance-roof',
      boxes: [
        floor,
        { center: [10, 1.5, 10], halfExtents: [2, 0.15, 2] },
        { center: [10, 0.6, 12.5], halfExtents: [1, 0.6, 0.2] },
      ],
      meshes: [],
    },
    layout: { ...TOWN, spawns: [{ x: 10, z: 10, interior: false }] },
    seed: 1,
  })
  try {
    const id = addPlayer(game.world, {
      accountId: 'stance',
      name: 'Rider',
      level: 1,
      prestige: 0,
      bot: false,
    })
    const player = game.world.players[id]
    if (!player) {
      throw new Error('Missing rider')
    }
    let seq = 0
    const step = (buttons = 0, moveX = 0, aim = 0) =>
      game.step([
        { seq: seq++, moveX, moveZ: 0, aim, pitch: 0, buttons, viewTime: game.world.tick },
      ])
    for (let tick = 0; tick < 20; tick++) {
      step(Buttons.crouch)
    }
    const entity = game.physics.app.root.findByName(String(id))
    const body = game.physics.players.get(String(id))
    if (!(entity instanceof Entity && entity.collision && body)) {
      throw new Error('Missing native capsule')
    }
    const lowered = structuredClone(body)
    expect(player.crouched).toBe(true)
    expect(entity.collision.height).toBe(1.2)
    for (let tick = 0; tick < 20; tick++) {
      step()
    }
    expect(player.crouched).toBe(true)
    expect(body.crouched).toBe(true)
    expect(entity.collision.height).toBe(1.2)
    step(Buttons.fire, 0, ANGLE_SCALE / 4)
    const shot = game.world.events.find((event) => event.type === 'shot')
    expect(shot?.origin.y).toBeCloseTo(player.y + 1.02, 4)
    expect((shot?.flags ?? 0) & SHOT_WALL).not.toBe(0)
    expect(shot?.end.z).toBeCloseTo(12.3, 2)
    for (let tick = 0; tick < 20; tick++) {
      step(0, 127)
    }
    expect(player.x).toBeGreaterThan(13)
    expect(player.crouched).toBe(false)
    expect(entity.collision.height).toBe(1.8)
    expect(eyeHeight(player)).toBeCloseTo(1.62)
    const standing = structuredClone(body)
    game.physics.adopt(String(id), lowered)
    expect(entity.collision.height).toBe(1.2)
    expect(entity.getPosition().y).toBeCloseTo(lowered.y - 0.9 + 0.6, 4)
    game.physics.step(new Map())
    expect(body.crouched).toBe(true)
    expect(body.y - 0.9).toBeCloseTo(lowered.y - 0.9, 4)
    game.physics.adopt(String(id), standing)
    expect(entity.collision.height).toBe(1.8)
    expect(entity.getPosition().y).toBeCloseTo(standing.y, 4)
    expect(body.crouched).toBe(false)
  } finally {
    game.dispose()
  }
})

it('effective native stance follows a committed slide and rejects disabled crouch commands', () => {
  const game = createSimulation({
    ammo,
    collision: { version: 'stance-slide', boxes: [floor], meshes: [] },
  })
  try {
    const body = game.addPlayer('self', [10, 0.9, 10])
    for (let tick = 0; tick < 20; tick++) {
      game.step(new Map())
    }
    game.step(new Map([['self', { ...neutralInput(), moveZ: -1, buttons: Buttons.sprint }]]))
    game.step(new Map([['self', { ...neutralInput(), moveZ: -1, buttons: Buttons.crouch }]]))
    expect(body.motion?.slideTicks).toBeGreaterThan(0)
    game.step(new Map())
    expect(body.crouched).toBe(true)
    for (let tick = 0; tick < 20; tick++) {
      game.step(new Map())
    }
    expect(body.crouched).toBe(false)
    const command = { ...neutralInput(), buttons: Buttons.crouch }
    for (const rider of [
      { alive: false, showdown: -1, lingerUntil: -1 },
      { alive: true, showdown: 0, lingerUntil: -1 },
      { alive: true, showdown: -1, lingerUntil: 1 },
    ]) {
      game.step(new Map([['self', predictionInput(command, rider)]]))
      expect(body.crouched).toBe(false)
    }
    expect(command.buttons).toBe(Buttons.crouch)
  } finally {
    game.dispose()
  }
})
