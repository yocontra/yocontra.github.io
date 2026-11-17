import { expect, test as it, spyOn } from 'bun:test'
import { Entity } from 'playcanvas'
import { firstPersonFixture } from './first-person-fixture.ts'

function upper(root: Entity) {
  const node = root.findByName('upper-body-pose')
  const layer = node instanceof Entity ? node.anim?.baseLayer : undefined
  if (!layer) {
    throw new Error('Missing actual native arms upper-body layer')
  }
  return layer
}
function weapon(root: Entity) {
  const mount = root.findByName('mount.WristR.drawn')
  if (!(mount instanceof Entity && mount.render)) {
    throw new Error('Missing actual native drawn revolver')
  }
  return mount.render
}

it('delayed arms borrow the accepted throw phase, preserve crouch time and restore weapons on cancellation', async () => {
  const clock = spyOn(performance, 'now').mockReturnValue(1250)
  const f = firstPersonFixture()
  const device = f.app.graphicsDevice
  const request = { ...f.request, throwingUntil: 1700 }
  try {
    const loading = f.model.prepare(request)
    await f.finish()
    await loading
    f.model.update(request)
    f.model.present(f.camera, 1 / 60)
    const root = f.actors()[0]
    if (!root) {
      throw new Error('Missing native arms')
    }
    expect(f.model.ready).toBe(true)
    expect(upper(root).activeState).toBe('Throw_Dynamite')
    expect(upper(root).activeStateCurrentTime).toBeCloseTo(0.25, 5)
    expect(weapon(root).enabled).toBe(false)
    expect(f.model.wrist('self')).toBe(root.findByName('WristR'))
    expect(f.model.wrist('someone-else')).toBeNull()
    f.app.systems.fire('animationUpdate', 0.05)
    clock.mockReturnValue(1300)
    request.player.crouched = true
    f.model.update(request)
    expect(upper(root).activeState).toBe('Crouch_Throw_Dynamite')
    expect(upper(root).activeStateCurrentTime).toBeCloseTo(0.3, 5)
    request.throwingUntil = 0
    f.model.update(request)
    expect(upper(root).activeState).toBe('Crouch_Idle_Gun_Pointing')
    expect(weapon(root).enabled).toBe(true)
  } finally {
    f.dispose()
    clock.mockRestore()
  }
  expect(device.textures.size).toBe(0)
  expect(device.buffers.size).toBe(0)
})

it('an expired throw and a new life cannot hide the gun or retain a dead presentation hand', async () => {
  const clock = spyOn(performance, 'now').mockReturnValue(1000)
  const f = firstPersonFixture()
  const device = f.app.graphicsDevice
  const request = { ...f.request, throwingUntil: 1700 }
  try {
    const loading = f.model.prepare(request)
    await f.finish()
    await loading
    f.model.update(request)
    f.model.present(f.camera, 1 / 60)
    const root = f.actors()[0]
    if (!root) {
      throw new Error('Missing native arms')
    }
    expect(weapon(root).enabled).toBe(false)
    request.player.hp = 0
    f.model.update(request)
    expect(f.model.ready).toBe(false)
    expect(f.model.wrist('self')).toBeNull()
    clock.mockReturnValue(1800)
    request.player.hp = 100
    f.model.update(request)
    f.model.present(f.camera, 1 / 60)
    expect(upper(root).activeState).toBe('Idle_Gun_Pointing')
    expect(weapon(root).enabled).toBe(true)
    request.throwingUntil = 2500
    f.model.update(request)
    expect(weapon(root).enabled).toBe(false)
    f.model.fire('self', false)
    request.throwingUntil = 0
    expect(upper(root).activeState).toBe('Gun_Shoot')
    expect(weapon(root).enabled).toBe(true)
    f.model.update(undefined)
    expect(f.model.wrist('self')).toBeNull()
  } finally {
    f.dispose()
    clock.mockRestore()
  }
  expect(device.textures.size).toBe(0)
  expect(device.buffers.size).toBe(0)
})
