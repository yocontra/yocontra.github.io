import { expect, it } from 'bun:test'
import { Vec3, World } from 'cannon-es'
import { Box3, Group, PerspectiveCamera, Quaternion, Vector3 } from 'three'
import type {
  CorpsePose,
  CorpseRig,
} from '../src/experiments/out-west/ffa/scene/crowd/corpse-rig.ts'
import { CorpsePhysics } from '../src/experiments/out-west/ffa/scene/ragdoll-body.ts'
import { CorpsePresentation } from '../src/experiments/out-west/ffa/scene/ragdoll-view.ts'

function fixture() {
  let poses = 0
  let resets = 0
  const rendered = new Vector3()
  const bounds = new Box3()
  const size = new Vector3(0.6, 1, 0.6)
  const root = new Group()
  const rig: CorpseRig = {
    identity: 'posed-real-model-fixture',
    root,
    velocity: new Vector3(),
    floor: { value: 0 },
    links: [
      {
        key: 'Hips',
        parent: -1,
        position: new Vector3(0, 1, -5),
        rotation: new Quaternion(),
        start: new Vector3(0, 1, -5),
        end: new Vector3(0, 1.3, -5),
        radius: 0.1,
        mass: 10,
      },
    ],
    bounds: (values: readonly CorpsePose[]) =>
      bounds.setFromCenterAndSize(values[0]?.position ?? rendered, size),
    pose: (values) => {
      poses++
      rendered.copy(values[0]?.position ?? rendered)
    },
    resetCloth: () => {
      resets++
    },
    dispose: () => root.removeFromParent(),
  }
  const world = new World({ gravity: new Vec3() })
  const physical = new CorpsePhysics(world, rig, {
    velocity: new Vector3(),
    impulse: new Vector3(),
  })
  const camera = new PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 1, 0)
  camera.lookAt(0, 1, -5)
  const presentation = new CorpsePresentation()
  presentation.update(camera, true, [physical])
  const move = (x: number) => {
    const body = physical.parts[0]?.body
    if (!body) {
      throw new Error('Missing actual physical part')
    }
    body.position.x = x
    body.previousPosition.copy(body.position)
    body.interpolatedPosition.copy(body.position)
  }
  return {
    physical,
    camera,
    presentation,
    root,
    rendered,
    move,
    world,
    poses: () => poses,
    resets: () => resets,
  }
}

it('skips offscreen floor skin/cloth work while physics and the independent blob remain live', () => {
  const value = fixture()
  try {
    const before = value.poses()
    value.move(30)
    value.physical.sync(false, value.presentation.view)
    expect(value.poses()).toBe(before)
    expect(value.physical.poseActive).toBe(false)
    expect(value.root.visible).toBe(false)
    expect(value.physical.visible).toBe(true)
    expect(value.world.bodies).toHaveLength(1)
    expect(value.physical.parts[0]?.body.position.x).toBe(30)
  } finally {
    value.physical.dispose()
  }
})

it('poses a newly visible sleeping corpse in the same camera frame and respects explicit FPS hiding', () => {
  const value = fixture()
  try {
    const priorResets = value.resets()
    value.move(30)
    value.physical.sync(false, value.presentation.view)
    value.physical.parts[0]?.body.sleep()
    const before = value.poses()
    value.camera.lookAt(30, 1, -5)
    value.presentation.update(value.camera, true, [value.physical])
    expect(value.poses()).toBe(before + 1)
    expect(value.rendered.x).toBe(30)
    expect(value.resets()).toBe(priorResets + 1)
    value.physical.sync(false, value.presentation.view)
    expect(value.resets()).toBe(priorResets + 1)
    expect(value.root.visible).toBe(true)
    value.physical.setVisible(false)
    value.presentation.update(value.camera, true, [value.physical])
    expect(value.root.visible).toBe(false)
    expect(value.physical.visible).toBe(false)
    value.physical.setVisible(true)
    value.presentation.update(value.camera, true, [value.physical])
    expect(value.root.visible).toBe(true)
  } finally {
    value.physical.dispose()
  }
})

it('keeps off-camera rigs posed and visible to the real shadow camera on higher tiers', () => {
  const value = fixture()
  try {
    value.move(30)
    value.presentation.update(value.camera, false, [value.physical])
    const before = value.poses()
    value.physical.sync(false, value.presentation.view)
    expect(value.poses()).toBe(before + 1)
    expect(value.physical.poseActive).toBe(true)
    expect(value.root.visible).toBe(true)
    expect(value.rendered.x).toBe(30)
  } finally {
    value.physical.dispose()
  }
})
