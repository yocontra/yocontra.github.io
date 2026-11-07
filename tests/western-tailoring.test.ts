import { expect, it } from 'bun:test'
import { file as readBunFile } from 'bun'
import { Vector3 } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { ANIM_DEAD } from '../src/experiments/out-west/contract/town.ts'
import { markCharacterSlots } from '../src/experiments/out-west/engine/assets.ts'
import { Locomotion } from '../src/experiments/out-west/ffa/scene/locomotion.ts'
import { bodyPieces } from '../src/experiments/out-west/scene/bake.ts'
import { vest } from '../src/experiments/out-west/scene/face.ts'
import { boneKey, bounds, sampleBody } from '../src/experiments/out-west/scene/fit.ts'
import { holsterDetail } from '../src/experiments/out-west/scene/holster-detail.ts'
import { dressedActor, loadoutOpts } from '../src/experiments/out-west/scene/loadout.ts'
import { measure } from '../src/experiments/out-west/scene/outfit.ts'
import { revolverDef } from '../src/experiments/out-west/scene/revolver.ts'
import { SLOT } from '../src/experiments/out-west/scene/roles.ts'

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
for (const base of ['player', 'casual', 'worker', 'suit', 'rugged', 'punk', 'king', 'woman']) {
  it(`fits continuous Western shirt and vest topology on the actual ${base} source rig`, async () => {
    const file = new URL(`../public/experiments/out-west/3d/models/${base}.glb`, import.meta.url)
    const source = await loader.parseAsync(await readBunFile(file).arrayBuffer(), '')
    markCharacterSlots(source)
    source.scene.updateMatrixWorld(true)
    const body = sampleBody(source.scene, source.scene)
    const height = bounds(body.samples).max.y - bounds(body.samples).min.y
    const bones = new Map(body.bones.map((bone) => [boneKey(bone.name), bone]))
    const fit = measure(body, bones)
    const straps = vest(fit, 0x33_22_11).slice(1)
    const a = new Vector3()
    const b = new Vector3()
    for (const strap of straps) {
      const pos = strap.geo.getAttribute('position')
      const index = strap.geo.getIndex()
      if (!index) {
        throw new Error('Vest strap has no index')
      }
      let longest = 0
      for (let i = 0; i < index.count; i += 3) {
        for (let edge = 0; edge < 3; edge++) {
          a.fromBufferAttribute(pos, index.getX(i + edge))
          b.fromBufferAttribute(pos, index.getX(i + ((edge + 1) % 3)))
          longest = Math.max(longest, a.distanceTo(b))
        }
      }
      // Crossed ribbons span the front/back of the shoulder; a fitted strip only joins neighbouring rows.
      expect(longest / height).toBeLessThan(0.15)
    }
    const pieces = bodyPieces(
      source.scene,
      source.scene,
      body,
      base === 'woman' ? 'fitted' : 'straight',
    )
    expect(
      pieces.filter(
        (piece) =>
          piece.slot === SLOT.Pauldron || piece.slot === SLOT.Bracer || piece.slot === SLOT.Belt,
      ),
    ).toHaveLength(0)
    const front = pieces.find((piece) => piece.slot === SLOT.Shirt)
    expect(front).toBeDefined()
    const normals = front?.geo.getAttribute('normal')
    expect(normals).toBeDefined()
    expect(Array.from(normals?.array ?? []).every(Number.isFinite)).toBe(true)
    for (const piece of [...pieces, ...straps]) {
      piece.geo.dispose()
    }
  })
}

it('authors visible floral tooling and silver conchos instead of two trim recolours', () => {
  const a = {
    grip: new Vector3(-0.06, -0.02, 0),
    rearX: -0.08,
    mouthX: -0.02,
    muzzle: new Vector3(0.22, 0, 0),
    cylinder: { cy: 0, hy: 0.028, hz: 0.026 },
    barrel: { cy: 0, hy: 0.012, hz: 0.01 },
  }
  const floral = loadoutOpts({ holster: 'holster.tooled-floral' }).holster
  const silver = loadoutOpts({ holster: 'holster.silver-conchos' }).holster
  if (!(floral && silver)) {
    throw new Error('Catalog holster missing')
  }
  const flower = holsterDetail(a, floral)
  const conchos = holsterDetail(a, silver)
  expect(flower[0]?.metal).toBe(false)
  expect(conchos[0]?.metal).toBe(true)
  expect(flower[0]?.geo.getAttribute('position').count).toBeGreaterThan(1000)
  expect(conchos[0]?.geo.getAttribute('position').count).toBeGreaterThan(200)
})

for (const outfit of ['outfit.striped-poncho', 'outfit.wool-duster', 'outfit.gamblers-frock']) {
  it(`retains the dressed ${outfit} mesh through the production death animation`, async () => {
    const source = await loader.parseAsync(
      await readBunFile(
        new URL('../public/experiments/out-west/3d/models/player.glb', import.meta.url),
      ).arrayBuffer(),
      '',
    )
    markCharacterSlots(source)
    const actor = dressedActor(source, revolverDef(0.32), { outfit })
    const geometry = actor.meshes[0]?.geometry
    const hat = actor.hat
    const loco = new Locomotion(actor, source.animations, 'casual')
    loco.set({
      anim: ANIM_DEAD,
      stance: 0,
      vx: 0,
      vz: 0,
      aim: 0,
      pitch: 0,
      holstered: false,
      long: false,
      shooting: false,
      detail: true,
    })
    for (let frame = 0; frame < 150; frame++) {
      loco.pre(1 / 60)
      actor.update(1 / 60)
    }
    expect(actor.meshes[0]?.geometry).toBe(geometry)
    expect(actor.hat).toBe(hat)
    expect(actor.root.visible).toBe(true)
    expect(actor.action('Death')?.getEffectiveWeight()).toBeGreaterThan(0.99)
    expect(actor.head?.getWorldPosition(new Vector3()).y).toBeLessThan(0.65)
    const skeleton = actor.meshes[0]?.skeleton
    skeleton?.computeBoneTexture()
    const texture = skeleton?.boneTexture
    let freed = 0
    texture?.addEventListener('dispose', () => {
      freed++
    })
    loco.dispose()
    actor.dispose()
    expect(freed).toBe(1)
    expect(skeleton?.boneTexture).toBeNull()
  })
}
