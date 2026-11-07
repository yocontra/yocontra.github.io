import { describe, expect, it } from 'bun:test'
import {
  Bone,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SkinnedMesh,
  Vector3,
} from 'three'
import { ViewModel } from '../src/experiments/out-west/ffa/client/viewmodel.ts'
import { mirrorQ, SupportHand } from '../src/experiments/out-west/ffa/scene/mirror-hand.ts'

describe('view-model look replacement', () => {
  it('keeps support fingers with the wrist when the fore-end hold rolls under the barrel', () => {
    const root = new Group()
    const right = new Bone()
    const left = new Bone()
    const fingerR = new Bone()
    const fingerL = new Bone()
    right.add(fingerR)
    left.add(fingerL)
    root.add(right, left)
    root.updateMatrixWorld(true)
    const support = new SupportHand(
      new Map([
        ['WristR', right],
        ['WristL', left],
        ['Index1R', fingerR],
        ['Index1L', fingerL],
      ]),
      new Vector3(1, 0, 0),
    )
    const turn = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.9)
    fingerR.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 0.4)
    left.quaternion.copy(turn)
    root.updateMatrixWorld(true)
    const normal = new Vector3(1, 0, 0)
    const expected = mirrorQ(
      fingerR.getWorldQuaternion(new Quaternion()),
      normal,
      new Quaternion(),
    ).premultiply(turn)
    support.fingersLike(normal, turn)
    expect(Math.abs(fingerL.getWorldQuaternion(new Quaternion()).dot(expected))).toBeCloseTo(1, 8)
  })

  it('detaches visible rehomed map weapons and releases owned hand geometry', () => {
    const rig = new Group()
    const root = new Group()
    const bodyGeo = new BufferGeometry()
    const gloveGeo = new BufferGeometry()
    const sharedGunGeo = new BufferGeometry()
    const material = new MeshStandardMaterial()
    let bodyDisposed = 0
    let gloveDisposed = 0
    let sharedDisposed = 0
    bodyGeo.addEventListener('dispose', () => bodyDisposed++)
    gloveGeo.addEventListener('dispose', () => gloveDisposed++)
    sharedGunGeo.addEventListener('dispose', () => sharedDisposed++)
    root.add(new SkinnedMesh(bodyGeo, material), new SkinnedMesh(gloveGeo, material))
    root.add(new Mesh(sharedGunGeo, material))
    const rifle = new Group()
    const shotgun = new Group()
    rig.add(root, rifle, shotgun)
    const state = {
      actor: { root, dispose: () => root.removeFromParent() },
      sightGeometries: new Set<BufferGeometry>(),
      fits: { revolver: null, rifle: { obj: rifle }, shotgun: { obj: shotgun } } as Record<
        'revolver' | 'rifle' | 'shotgun',
        { obj: Group } | null
      >,
      held: { obj: rifle },
      bones: new Map([['WristR', null]]),
      support: {},
      action: {},
      mixAcc: 0,
    }
    const clear = (ViewModel.prototype as unknown as { clearBody: (this: typeof state) => void })
      .clearBody
    clear.call(state)
    expect(rig.children).toHaveLength(0)
    expect(state.fits).toEqual({ revolver: null, rifle: null, shotgun: null })
    expect(state.held).toBeNull()
    expect(state.bones.size).toBe(0)
    expect(bodyDisposed).toBe(1)
    expect(gloveDisposed).toBe(1)
    expect(sharedDisposed).toBe(0)
    clear.call(state)
    expect(bodyDisposed).toBe(1)
    expect(gloveDisposed).toBe(1)
    sharedGunGeo.dispose()
  })
})
