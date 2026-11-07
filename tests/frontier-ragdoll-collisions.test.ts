import { describe, expect, it } from 'bun:test'
import { Body, Plane, Sphere, Vec3, World } from 'cannon-es'
import { SparseCorpseContacts } from '../src/experiments/out-west/ffa/scene/ragdoll-collisions.ts'

function fixture(sparse: boolean) {
  const world = new World({ gravity: new Vec3(0, -9.81, 0), allowSleep: true })
  if (sparse) {
    world.collisionMatrix = new SparseCorpseContacts()
    world.collisionMatrixPrevious = new SparseCorpseContacts()
  }
  const names = new Map<Body, string>()
  const trace: string[] = []
  const label = (a: Body, b: Body) => {
    const left = names.get(a)
    const right = names.get(b)
    if (!(left && right)) {
      throw new Error('Cannon returned an unknown contact body')
    }
    return left < right ? `${left}/${right}` : `${right}/${left}`
  }
  const add = (name: string, body: Body) => {
    names.set(body, name)
    world.addBody(body)
    body.addEventListener('collide', (event: { body: Body }) => {
      trace.push(`collide:${label(body, event.body)}`)
    })
    return body
  }
  world.addEventListener('beginContact', (event: { bodyA: Body; bodyB: Body }) => {
    trace.push(`begin:${label(event.bodyA, event.bodyB)}`)
  })
  world.addEventListener('endContact', (event: { bodyA: Body; bodyB: Body }) => {
    trace.push(`end:${label(event.bodyA, event.bodyB)}`)
  })
  const floor = new Body({ mass: 0, shape: new Plane() })
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0)
  add('floor', floor)
  const ball = add(
    'ball',
    new Body({ mass: 1, shape: new Sphere(0.25), position: new Vec3(0, 1, 0) }),
  )
  const step = (count: number) => {
    for (let i = 0; i < count; i++) {
      world.step(1 / 120)
    }
  }
  return { world, ball, floor, trace, add, step }
}

function contactSequence(sparse: boolean): string[] {
  const f = fixture(sparse)
  f.step(360)
  f.ball.sleep()
  f.step(60)
  f.ball.position.set(0, 2, 0)
  f.ball.velocity.set(0, 0, 0)
  f.ball.aabbNeedsUpdate = true
  f.ball.wakeUp()
  f.step(360)
  f.world.removeBody(f.ball)
  f.step(2)
  f.ball.position.set(0, 2, 0)
  f.ball.velocity.set(0, 0, 0)
  f.ball.aabbNeedsUpdate = true
  f.ball.wakeUp()
  f.world.addBody(f.ball)
  f.step(360)
  return f.trace
}

describe('sparse contacts through the actual Cannon event lifecycle', () => {
  it('matches dense begin/end/collide events through rest, sleep, wake and same-body re-add', () => {
    const reference = contactSequence(false)
    const sparse = contactSequence(true)
    expect(sparse).toEqual(reference)
    expect(sparse.filter((event) => event === 'begin:ball/floor').length).toBeGreaterThanOrEqual(3)
    expect(sparse.filter((event) => event === 'end:ball/floor').length).toBeGreaterThanOrEqual(2)
    // Both bodies receive Cannon's first-contact callbacks, including contacts after wake/re-add.
    expect(sparse.filter((event) => event === 'collide:ball/floor').length).toBeGreaterThanOrEqual(
      6,
    )
  })

  it('preserves existing contact identity when unrelated removal renumbers the bodies', () => {
    const f = fixture(true)
    const spacer = f.add(
      'spacer',
      new Body({ mass: 0, shape: new Sphere(0.1), position: new Vec3(100, 100, 100) }),
    )
    const second = f.add(
      'second',
      new Body({
        mass: 1,
        shape: new Sphere(0.25),
        position: new Vec3(3, 1, 0),
        allowSleep: false,
      }),
    )
    f.step(360)
    const callbacks = f.trace.length
    const index = second.index
    f.world.removeBody(spacer)
    expect(second.index).toBe(index - 1)
    f.step(60)
    expect(f.trace).toHaveLength(callbacks)
    expect(f.world.collisionMatrix.get(second, f.floor)).toBe(1)
    expect(f.world.collisionMatrix.matrix).toHaveLength(0)
  })
})
