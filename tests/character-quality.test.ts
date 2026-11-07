import { describe, expect, it } from 'bun:test'
import {
  AnimationClip,
  Group,
  InstancedMesh,
  Matrix4,
  PerspectiveCamera,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from 'three'
import { ANIM_AIM, EF_ALIVE, STANCE_ADS } from '../src/experiments/out-west/contract/town.ts'
import { aimedGaits } from '../src/experiments/out-west/ffa/scene/crowd/aim-gait.ts'
import { GunBatch } from '../src/experiments/out-west/ffa/scene/crowd/gun-batch.ts'
import { silhouetteKey } from '../src/experiments/out-west/ffa/scene/crowd/silhouette.ts'
import { socketAt } from '../src/experiments/out-west/ffa/scene/crowd/tracks.ts'
import { Crowd, type CrowdPlayer } from '../src/experiments/out-west/ffa/scene/crowd.ts'
import { farStance } from '../src/experiments/out-west/ffa/scene/crowd-motion.ts'
import { lookFor } from '../src/experiments/out-west/ffa/scene/looks.ts'
import { makeHat } from '../src/experiments/out-west/scene/hats.ts'
import { equippedGun, finishedGun, gunFinish } from '../src/experiments/out-west/scene/loadout.ts'
import type { PropDef } from '../src/experiments/out-west/scene/props.ts'
import { revolverDef, revolverGeometry } from '../src/experiments/out-west/scene/revolver.ts'
import { spurGeometry } from '../src/experiments/out-west/scene/spurs.ts'
import { OUTFITS } from '../src/experiments/out-west/scene/wardrobe.ts'

const rider: CrowdPlayer = {
  id: 2,
  x: 0,
  y: 0,
  z: 0,
  aim: 0,
  vx: 3,
  vz: 0,
  anim: ANIM_AIM,
  stance: STANCE_ADS,
  flags: EF_ALIVE,
  self: false,
}

describe('character presentation continuity', () => {
  it('keeps a moving aimed rider walking rather than sliding in the far crowd', () => {
    expect(farStance(rider, 'Walk', () => true)).toBe('Walk_Aim')
    expect(farStance(rider, 'Run', () => true)).toBe('Run_Aim')
    expect(farStance({ ...rider, vx: 0 }, 'Idle', () => true)).toBe('Idle_Gun_Pointing')
  })

  it('keeps catalog coat cuts and colours in Frontier', () => {
    for (const id of [
      'outfit.gamblers-frock',
      'outfit.undertakers-black',
      'outfit.midnight-coat',
    ] as const) {
      const look = lookFor([id], 3).look
      expect(look.coat).toBe(OUTFITS[id]?.coat)
      expect(look.coatCut).toBe(OUTFITS[id]?.coatCut ?? 'duster')
      expect(look.tint).toMatchObject(OUTFITS[id]?.tint ?? {})
    }
  })

  it('shows both guns for a paired catalog item', () => {
    const gun = { size: { x: 0.32 }, userData: {} } as PropDef
    const pair = finishedGun(gun, 'gun.hardins-pair')
    expect(pair).toBeInstanceOf(Group)
    expect(pair?.children.length).toBe(2)
    expect(finishedGun(gun, 'gun.engraved-ivory')?.children.length).not.toBe(2)
  })
  it('keys coats and ponchos independently while sharing palette-only variants', () => {
    const plain = { base: 'suit' as const, tint: {}, scale: 1 }
    expect(silhouetteKey(plain)).not.toBe(silhouetteKey({ ...plain, coat: 0x22_22_22 }))
    expect(silhouetteKey({ ...plain, coat: 0x22_22_22 })).not.toBe(
      silhouetteKey({ ...plain, coat: 0x22_22_22, coatCut: 'frock' }),
    )
    expect(silhouetteKey(plain)).toBe(silhouetteKey({ ...plain, tint: { Shirt: 0xab_cd_ef } }))
  })

  it('interpolates far equipment on the same frame clock as its body', () => {
    const track = new Float32Array([0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 2, 1, 0, 0, 0, 0, 1, 1, 1, 1])
    const matrix = new Matrix4()
    expect(socketAt(track, { name: 'Walk', start: 0, frames: 2 }, 0.5, matrix)).toBe(true)
    expect(matrix.elements[12]).toBeCloseTo(1)
    expect(matrix.elements[13]).toBeCloseTo(1)
    expect(socketAt(undefined, { name: 'Walk', start: 0, frames: 2 }, 0, matrix)).toBe(false)
  })

  it('gives named hats authored geometry rather than a colour-only variant', () => {
    const base = makeHat('cowboy', 0x66_66_66)
    const hole = makeHat('cowboy', 0x66_66_66, { detail: 'holed' })
    const bronze = makeHat('cowboy', 0x66_66_66, { detail: 'bronze' })
    const mesh = (hat: Group) =>
      hat.children[0]?.children[0] as { geometry: { index: { count: number } } } | undefined
    expect(mesh(hole)?.geometry.index.count).not.toBe(mesh(base)?.geometry.index.count)
    expect(mesh(bronze)?.geometry.index.count).toBeGreaterThan(
      mesh(base)?.geometry.index.count ?? 0,
    )
  })
  it('updates the rider identity when the equipped gun changes', () => {
    const plain = lookFor(['gun.rusty-six'], 7)
    const pair = lookFor(['gun.hardins-pair'], 7)
    expect(pair.gun).toBe('gun.hardins-pair')
    expect(pair.key).not.toBe(plain.key)
    expect(pair.look.offGun).toBe(true)
    expect(silhouetteKey(pair.look)).not.toBe(silhouetteKey(plain.look))
  })

  it('instances distinct finishes separately at near and far gun detail', () => {
    const root = new Group()
    const batch = new GunBatch(root, 8, { geometry: revolverGeometry(0.32, 'lo'), distance: 5 })
    for (const id of ['gun.rusty-six', 'gun.engraved-ivory'] as const) {
      const gun = equippedGun(revolverDef(0.32, 'mid'), id)
      root.add(gun)
      batch.adopt(gun)
      batch.push(gun)
    }
    root.updateMatrixWorld(true)
    const camera = new PerspectiveCamera()
    camera.position.z = 10
    camera.updateMatrixWorld(true)
    batch.sync(camera)
    const drawing = root.children.filter(
      (child): child is InstancedMesh => child instanceof InstancedMesh && child.count > 0,
    )
    expect(drawing).toHaveLength(2)
    expect(new Set(drawing.map((mesh) => mesh.geometry)).size).toBe(2)
    expect(gunFinish('gun.engraved-ivory').grip.band).toBe(4)
  })
  it('keeps an uncached rooftop rider muzzle above its own support surface', () => {
    const muzzle = new Vector3()
    Reflect.apply(Crowd.prototype.muzzle, { members: new Map(), readScale: 1 }, [
      7,
      10,
      20,
      0,
      muzzle,
      6,
    ])
    expect(muzzle.y).toBeCloseTo(7.35)
    expect(muzzle.x).toBeCloseTo(10.7)
  })
  it('builds pointed spur rowels with compatible merged geometry', () => {
    const star = spurGeometry(5, false)
    const silver = spurGeometry(10, true)
    expect(star.getAttribute('position').count).toBeGreaterThan(100)
    expect(silver.getAttribute('position').count).toBeGreaterThan(
      star.getAttribute('position').count,
    )
    star.computeBoundingBox()
    expect(star.boundingBox?.min.z).toBeLessThan(-0.02)
  })
  it('builds visible fallback actors after a VAT failure without reviving departed riders', async () => {
    const current = { id: 1, vatKey: 'coat', actor: null }
    const departed = { id: 2, vatKey: 'coat', actor: null }
    const unrelated = { id: 3, vatKey: 'poncho', actor: null }
    const members = new Map([
      [1, current],
      [2, departed],
      [3, unrelated],
    ])
    const built: number[] = []
    const fallback = {
      members,
      failedVats: new Set(['coat']),
      isDisposed: () => false,
      build: (member: typeof current) => built.push(member.id),
    }
    const finished = Reflect.apply(Reflect.get(Crowd.prototype, 'fallbackActors'), fallback, [
      'coat',
    ]) as Promise<void>
    members.delete(2)
    await finished
    expect(built).toEqual([1])
    fallback.isDisposed = () => true
    await Reflect.apply(Reflect.get(Crowd.prototype, 'fallbackActors'), fallback, ['coat'])
    expect(built).toEqual([1])
  })
  it('bakes a moving aimed pose without freezing or replacing the authored leg cycle', () => {
    const legs = new VectorKeyframeTrack('Hips.position', [0, 1.3], [0, 0, 0, 0, 0.04, 0.1])
    const rest = new QuaternionKeyframeTrack(
      'UpperArmR.quaternion',
      [0, 1.3],
      [0, 0, 0, 1, 0, 0, 0, 1],
    )
    const pointed = new QuaternionKeyframeTrack(
      'UpperArmR.quaternion',
      [0, 1],
      [0, 0, 0.5, 0.866, 0, 0, 0.6, 0.8],
    )
    const walk = new AnimationClip('Walk', 1.3, [legs, rest])
    const aim = new AnimationClip('Idle_Gun_Pointing', 1, [pointed])
    const made = aimedGaits([walk, aim])[0]
    expect(made?.name).toBe('Walk_Aim')
    expect(made?.duration).toBe(walk.duration)
    expect(made?.tracks[0]).toBe(legs)
    expect(Array.from(made?.tracks[1]?.values ?? [])).toEqual([
      0,
      0,
      0.5,
      Math.fround(0.866),
      0,
      0,
      0.5,
      Math.fround(0.866),
    ])
    expect(Array.from(rest.values)).toEqual([0, 0, 0, 1, 0, 0, 0, 1])
  })
})
