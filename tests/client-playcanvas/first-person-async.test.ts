import { expect, test as it } from 'bun:test'
import { Entity, SHADER_FORWARD, SHADER_PREPASS } from 'playcanvas'
import type { FirstPersonRequest } from '../../src/experiments/out-west/client/first-person-model.ts'
import { WEAPON_RIFLE, WEAPON_SHOTGUN } from '../../src/experiments/out-west/contract/town.ts'
import { DEFAULT_LOADOUT } from '../../src/experiments/out-west/data/catalog.ts'
import { newPlayer } from '../../src/experiments/out-west/ffa/sim/state.ts'
import { firstPersonFixture, flush } from './first-person-fixture.ts'

it('builds native arms and mounted weapons disabled, then presents atomically and releases textures', async () => {
  const f = firstPersonFixture()
  try {
    const before = f.world.render?.meshInstances[0]?.shaderPassMask
    const done = f.model.prepare(f.request)
    expect(f.requests).toHaveLength(1)
    expect(f.model.stats().pending).toBe(1)
    f.requests[0]?.finish()
    await flush()
    expect(f.requests).toHaveLength(3)
    expect(f.actors()).toHaveLength(1)
    expect(f.actors().every((actor) => !actor.enabled)).toBe(true)
    expect(f.model.ready).toBe(false)
    f.requests[1]?.finish()
    await flush()
    expect(f.model.ready).toBe(false)
    f.requests[2]?.finish()
    await done
    expect(f.model.stats()).toEqual({ arms: 1, pending: 0, masked: 0 })
    expect(f.model.ready).toBe(false)
    expect(f.actors().every((actor) => !actor.enabled)).toBe(true)
    f.model.present(f.camera, 1 / 60)
    expect(f.model.ready).toBe(true)
    expect(f.world.render?.meshInstances[0]?.shaderPassMask).toBe(
      (before ?? 0) & ~((1 << SHADER_FORWARD) | (1 << SHADER_PREPASS)),
    )
    expect(
      f
        .actors()
        .flatMap((actor) => actor.findComponents('render'))
        .every((render) => !render.castShadows),
    ).toBe(true)
    expect(f.textureLoads).toEqual(['fixture://shared-albedo'])
    expect(f.textureReleases).toEqual([])
    f.model.destroy()
    expect(f.actors()).toHaveLength(0)
    expect(f.world.render?.meshInstances[0]?.shaderPassMask).toBe(before)
    expect(f.textures.size).toBe(0)
    for (const texture of f.textureInstances) {
      expect(texture.device).toBeNull()
    }
    expect(f.textureReleases).toEqual(['fixture://shared-albedo'])
    expect(f.released).toEqual([f.requests[0]?.url ?? 'missing request'])
  } finally {
    f.dispose()
  }
})

it('death cancels preparation without starting another build until a live request arrives', async () => {
  const f = firstPersonFixture()
  const loading = f.model.prepare(f.request)
  try {
    f.model.update({ ...f.request, player: { ...f.request.player, hp: 0 } })
    f.requests[0]?.finish()
    await loading
    expect(f.requests).toHaveLength(1)
    expect(f.actors()).toHaveLength(0)
    expect(f.model.failed).toBe(false)
    for (const texture of f.textureInstances) {
      expect(texture.device).toBeNull()
    }
    const alive = f.model.prepare(f.request)
    await f.finish(1)
    await alive
    f.model.present(f.camera, 1 / 60)
    expect(f.model.ready).toBe(true)
    expect(f.actors()).toHaveLength(1)
  } finally {
    f.model.destroy()
    for (const pending of f.requests) {
      pending.finish()
    }
    await flush()
    f.dispose()
  }
})

it('repeated single/paired fit swaps preserve drawn guns and balance native texture leases', async () => {
  const f = firstPersonFixture()
  const paired = {
    ...f.request,
    appearance: {
      key: 'paired',
      loadout: { ...DEFAULT_LOADOUT, outfit: 'outfit.wool-duster', gun: 'gun.hardins-pair' },
      dyes: {},
    },
  } satisfies FirstPersonRequest
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const [request, guns] of [
        [paired, 2],
        [f.request, 1],
      ] as const) {
        const index = f.requests.length
        const loading = f.model.prepare(request)
        await f.finish(index)
        await loading
        f.model.update(request)
        f.model.present(f.camera, 1 / 60)
        expect(f.model.ready).toBe(true)
        expect(f.actors()).toHaveLength(1)
        const actor = f.actors()[0]
        const drawn =
          actor?.find((node) => node.name.startsWith('mount.Wrist') && node.enabled) ?? []
        expect(drawn).toHaveLength(guns)
        f.model.fire('self', false)
        const upper = actor?.findByName('upper-body-pose')
        expect(upper instanceof Entity && upper.anim?.baseLayer?.activeState).toBe(
          guns === 2 ? 'Gun_Shoot_Pair' : 'Gun_Shoot',
        )
        for (const gun of drawn) {
          expect(
            gun instanceof Entity && gun.anim?.baseLayer?.activeState.startsWith('Weapon_Shoot'),
          ).toBe(true)
        }
        expect(f.textures.size).toBe(1)
        expect(f.textureInstances).toHaveLength(1)
        expect(f.textureInstances[0]?.device).toBe(f.app.graphicsDevice)
      }
    }
    f.model.destroy()
    expect(f.actors()).toHaveLength(0)
    for (const texture of f.textureInstances) {
      expect(texture.device).toBeNull()
    }
    expect(f.textureLoads).toEqual(['fixture://shared-albedo'])
    expect(f.textureReleases).toEqual(['fixture://shared-albedo'])
    expect(f.released).toHaveLength(6)
  } finally {
    f.model.destroy()
    for (const pending of f.requests) {
      pending.finish()
    }
    await flush()
    f.dispose()
  }
})

it('serializes replacements and prepares only the latest requested appearance', async () => {
  const f = firstPersonFixture()
  const first = f.model.prepare(f.request)
  try {
    await f.finish()
    await first
    f.model.present(f.camera, 1 / 60)
    const active = f.actors()[0]
    if (!active) {
      throw new Error('Initial actor was not installed')
    }
    const old = f.model.prepare(f.appearance('old'))
    expect(f.model.ready).toBe(false)
    expect(f.model.stats().masked).toBe(0)
    f.requests[3]?.finish()
    await flush()
    expect(f.actors()).toHaveLength(2)
    expect(f.actors().every((actor) => !actor.enabled)).toBe(true)
    const middle = f.model.prepare(f.appearance('middle'))
    const latest = f.model.prepare(f.appearance('latest'))
    expect(f.actors()).toEqual([active])
    expect(f.requests.filter((load) => load.url.includes('/viewmodels/'))).toHaveLength(2)
    f.requests[4]?.finish()
    f.requests[5]?.finish()
    await Promise.all([old, middle])
    await flush()
    expect(f.requests.filter((load) => load.url.includes('/viewmodels/'))).toHaveLength(3)
    await f.finish(6)
    await latest
    expect(f.actors()).toHaveLength(1)
    expect(f.actors()[0]).not.toBe(active)
    expect(f.actors()[0]?.enabled).toBe(false)
    expect(f.textureReleases).toHaveLength(0)
    f.model.present(f.camera, 1 / 60)
    expect(f.model.ready).toBe(true)
    f.model.destroy()
    expect(f.textures.size).toBe(0)
    for (const texture of f.textureInstances) {
      expect(texture.device).toBeNull()
    }
    expect(f.released).toEqual([f.requests[0]?.url ?? 'missing request'])
  } finally {
    f.model.destroy()
    for (const pending of f.requests) {
      pending.finish()
    }
    await flush()
    f.dispose()
  }
})

it('uses the latest held gun when the same appearance finishes, and cancels a changed life', async () => {
  const f = firstPersonFixture()
  const domain = newPlayer(0, {
    accountId: 'self',
    name: 'Rider',
    level: 1,
    prestige: 0,
    bot: false,
  })
  domain.alive = true
  domain.spawnTick = 1
  domain.weapon = WEAPON_RIFLE
  const request = { ...f.request, domain }
  const first = f.model.prepare(request)
  try {
    f.requests[0]?.finish()
    await flush()
    domain.weapon = WEAPON_SHOTGUN
    f.model.update(request)
    f.requests[1]?.finish()
    f.requests[2]?.finish()
    await first
    f.model.present(f.camera, 1 / 60)
    const held = f.actors()[0]?.findByName('mount.Chest.long')
    const mounts = f.actors()[0]?.find((node) => node.name === 'mount.Chest.long') ?? []
    expect(held).toBeDefined()
    expect(mounts.filter((mount) => mount.enabled)).toHaveLength(1)
    expect(mounts.find((mount) => mount.enabled)?.findByName('socket.muzzle')).toBeDefined()
    const drawn = mounts.find((mount) => mount.enabled)
    expect(
      drawn instanceof Entity && drawn.anim?.baseLayer?.states.includes('Weapon_Idle_shotgun'),
    ).toBe(true)
    const replacement = { ...f.appearance('replacement'), domain }
    const oldLife = f.model.prepare(replacement)
    f.requests[3]?.finish()
    await flush()
    expect(f.actors()).toHaveLength(2)
    // The real sim mutates this player object; the pending identity must be a snapshot.
    domain.spawnTick = 2
    const nextLife = f.model.prepare(replacement)
    expect(f.actors()).toHaveLength(1)
    f.requests[4]?.finish()
    f.requests[5]?.finish()
    await oldLife
    await flush()
    await f.finish(6)
    await nextLife
    f.model.update(replacement)
    f.model.present(f.camera, 1 / 60)
    expect(f.model.ready).toBe(true)
    expect(f.actors()).toHaveLength(1)
  } finally {
    f.model.destroy()
    for (const pending of f.requests) {
      pending.finish()
    }
    await flush()
    f.dispose()
  }
})

it('late native lights illuminate arms and lose the temporary layer when it is disposed', () => {
  const f = firstPersonFixture()
  try {
    const layer = f.app.scene.layers.getLayerByName('Viewmodel')
    expect(layer).not.toBeNull()
    const light = new Entity('late sunlight', f.app)
    f.app.root.addChild(light)
    light.addComponent('light', { type: 'directional' })
    expect(light.light?.layers).toContain(layer?.id)
    const removed = new Entity('temporary light', f.app)
    f.app.root.addChild(removed)
    removed.addComponent('light', { type: 'point' })
    removed.destroy()
    f.model.destroy()
    expect(light.light?.layers).not.toContain(layer?.id)
    expect(f.camera.camera?.layers).not.toContain(layer?.id)
    expect(f.app.scene.layers.getLayerByName('Viewmodel')).toBeNull()
    const future = new Entity('future sunlight', f.app)
    f.app.root.addChild(future)
    future.addComponent('light', { type: 'directional' })
    expect(future.light?.layers).not.toContain(layer?.id)
  } finally {
    f.dispose()
  }
})

it('a failed held attachment cannot revive its retired actor when the sibling load arrives', async () => {
  const f = firstPersonFixture()
  const done = f.model.prepare(f.request)
  try {
    f.requests[0]?.finish()
    await flush()
    f.requests[1]?.done.reject(new Error('Missing rifle'))
    await done
    expect(f.model.failed).toBe(true)
    expect(f.actors()).toHaveLength(0)
    expect(f.textures.size).toBe(0)
    for (const texture of f.textureInstances) {
      expect(texture.device).toBeNull()
    }
    f.requests[2]?.finish()
    await flush()
    expect(f.actors()).toHaveLength(0)
    expect(f.textures.size).toBe(0)
    for (const texture of f.textureInstances) {
      expect(texture.device).toBeNull()
    }
    expect(f.created.every((entity) => entity.parent === null)).toBe(true)
    expect(f.released).toEqual([f.requests[0]?.url ?? 'missing request'])
    f.model.retry()
    const retry = f.model.prepare(f.request)
    await f.finish(3)
    await retry
    f.model.present(f.camera, 1 / 60)
    expect(f.model.failed).toBe(false)
    expect(f.model.ready).toBe(true)
  } finally {
    f.model.destroy()
    for (const pending of f.requests) {
      pending.finish()
    }
    await flush()
    f.dispose()
  }
})

it('a texture that resolves after disposal is released without starting held attachments', async () => {
  const f = firstPersonFixture()
  f.delayTextures()
  const done = f.model.prepare(f.request)
  try {
    f.requests[0]?.finish()
    await flush()
    expect(f.texturePending).toHaveLength(1)
    f.model.destroy()
    f.texturePending[0]?.finish()
    await done
    expect(f.requests).toHaveLength(1)
    expect(f.actors()).toHaveLength(0)
    expect(f.textures.size).toBe(0)
    for (const texture of f.textureInstances) {
      expect(texture.device).toBeNull()
    }
    expect(f.textureReleases).toEqual(['fixture://shared-albedo'])
    expect(f.released).toEqual([f.requests[0]?.url ?? 'missing request'])
  } finally {
    f.model.destroy()
    for (const pending of f.texturePending) {
      pending.finish()
    }
    for (const pending of f.requests) {
      pending.finish()
    }
    await done
    f.dispose()
  }
})

it('cancellation before the arms arrive starts no late weapon loads and releases the late resource', async () => {
  const f = firstPersonFixture()
  const done = f.model.prepare(f.request)
  try {
    f.model.update(undefined)
    f.requests[0]?.finish()
    await flush()
    expect(f.requests).toHaveLength(1)
    await done
    expect(f.actors()).toHaveLength(0)
    expect(f.model.ready).toBe(false)
    expect(f.textures.size).toBe(0)
    for (const texture of f.textureInstances) {
      expect(texture.device).toBeNull()
    }
    expect(f.released).toEqual([f.requests[0]?.url ?? 'missing request'])
  } finally {
    for (const pending of f.requests) {
      pending.finish()
    }
    await done
    f.dispose()
  }
})

it('disposal removes a disabled actor immediately while its held weapons are still loading', async () => {
  const f = firstPersonFixture()
  const done = f.model.prepare(f.request)
  try {
    f.requests[0]?.finish()
    await flush()
    expect(f.actors()).toHaveLength(1)
    expect(f.requests).toHaveLength(3)
    f.model.destroy()
    expect(f.actors()).toHaveLength(0)
    expect(f.textures.size).toBe(0)
    for (const texture of f.textureInstances) {
      expect(texture.device).toBeNull()
    }
    f.requests[1]?.finish()
    f.requests[2]?.finish()
    await done
    await flush()
    expect(f.actors()).toHaveLength(0)
    expect(f.textures.size).toBe(0)
    for (const texture of f.textureInstances) {
      expect(texture.device).toBeNull()
    }
    expect(f.released).toEqual([f.requests[0]?.url ?? 'missing request'])
    expect(f.model.failed).toBe(false)
  } finally {
    for (const pending of f.requests) {
      pending.finish()
    }
    await done
    f.dispose()
  }
})
