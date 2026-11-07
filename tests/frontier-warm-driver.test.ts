import { expect, it } from 'bun:test'
import {
  BoxGeometry,
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
} from 'three'
import type { Assets } from '../src/experiments/out-west/engine/assets.ts'
import { Renderer } from '../src/experiments/out-west/engine/render.ts'
import { ViewModel } from '../src/experiments/out-west/ffa/client/viewmodel.ts'
import { type VatBake, VatCrowd } from '../src/experiments/out-west/ffa/scene/crowd/vat.ts'
import { Crowd } from '../src/experiments/out-west/ffa/scene/crowd.ts'
import { lookFor } from '../src/experiments/out-west/ffa/scene/looks.ts'

interface Fault {
  output: 'screen' | 'composer'
  stage: 'compile' | 'render'
}
const faults: Fault[] = ['screen', 'composer'].flatMap((output) =>
  ['compile', 'render'].map((stage) => ({ output, stage }) as Fault),
)

/** Invoke the production wrapper, rather than a directly throwing cache callback. */
function driver(scene: Scene, fault: Fault) {
  const original = { original: true }
  const composer = { composer: true }
  let target: object | null = original
  let failing = false
  const outputs: (object | null)[] = []
  const shadows = { enabled: true, autoUpdate: false, needsUpdate: false }
  const stage = (current: Fault['stage']) => {
    if (current === 'render') {
      outputs.push(target)
    }
    if (
      failing &&
      current === fault.stage &&
      target === (fault.output === 'screen' ? null : composer)
    ) {
      throw new Error('actual driver failure')
    }
  }
  const state = {
    gl: {
      shadowMap: shadows,
      getRenderTarget: () => target,
      setRenderTarget: (value: object | null) => {
        target = value
      },
      compile: () => stage('compile'),
      render: () => stage('render'),
    },
    composer: { inputBuffer: composer },
  }
  return {
    original,
    composer,
    outputs,
    shadows,
    get target() {
      return target
    },
    fail(value: boolean) {
      failing = value
    },
    warm: () => Reflect.apply(Renderer.prototype.warmSync, state, [scene, new PerspectiveCamera()]),
  }
}

function crowdFixture() {
  const previous = Reflect.get(globalThis, 'document')
  Reflect.set(globalThis, 'document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  })
  const scene = new Scene()
  const crowd = new Crowd(scene, {} as Assets, 0)
  const members = Reflect.get(crowd, 'members') as Map<number, unknown>
  return {
    crowd,
    scene,
    members,
    dispose: () => {
      members.clear()
      crowd.dispose()
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, 'document')
      } else {
        Reflect.set(globalThis, 'document', previous)
      }
    },
  }
}

it.each(faults)(
  'does not retire self programs after a $output $stage failure inside the renderer',
  (fault) => {
    const f = crowdFixture()
    const root = Reflect.get(f.crowd, 'root') as Group
    root.visible = false
    const holder = new Group()
    const material = new MeshStandardMaterial({ alphaHash: true, opacity: 0.35 })
    const mesh = new Mesh(new BoxGeometry(), material)
    mesh.visible = false
    holder.visible = false
    holder.add(mesh)
    const actor = { root: holder }
    let retired = 0
    const previous = { actor: { dispose: () => retired++ } }
    const member = { actor, holder, skin: [] }
    Reflect.set(f.crowd, 'warmedSelf', previous.actor)
    Reflect.set(f.crowd, 'retiredSelf', previous)
    Reflect.set(f.crowd, 'destroyActor', (old: typeof previous) => old.actor.dispose())
    f.members.set(1, member)
    const d = driver(f.scene, fault)
    try {
      d.fail(true)
      expect(() => f.crowd.warmSelf(1, d.warm)).toThrow('actual driver failure')
      expect(Reflect.get(f.crowd, 'warmedSelf')).toBe(previous.actor)
      expect(Reflect.get(f.crowd, 'retiredSelf')).toBe(previous)
      expect(retired).toBe(0)
      expect(d.target).toBe(d.original)
      expect(d.shadows).toEqual({ enabled: true, autoUpdate: false, needsUpdate: false })
      expect(holder.parent).toBeNull()
      expect(root.visible || holder.visible || mesh.visible).toBe(false)
      expect(mesh.frustumCulled).toBe(true)
      expect(material.alphaHash).toBe(true)
      expect(material.opacity).toBe(0.35)
      d.fail(false)
      f.crowd.warmSelf(1, d.warm)
      expect(d.outputs.slice(-4)).toEqual([null, d.composer, null, d.composer])
      expect(Reflect.get(f.crowd, 'warmedSelf')).toBe(actor)
      expect(Reflect.get(f.crowd, 'retiredSelf')).toBeNull()
      expect(retired).toBe(1)
      const count = d.outputs.length
      f.crowd.warmSelf(1, d.warm)
      expect(d.outputs.length).toBe(count)
    } finally {
      f.dispose()
      mesh.geometry.dispose()
      material.dispose()
    }
  },
)

function body(): VatCrowd {
  const geometry = new BufferGeometry().setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, 0], 3),
  )
  return new VatCrowd(
    {
      geometry,
      posTex: new DataTexture(),
      nrmTex: new DataTexture(),
      vertexCount: 1,
      clips: [{ name: 'Idle', start: 3, frames: 12 }],
    } as VatBake,
    4,
  )
}

it.each(faults)(
  'does not retire view-model programs after a $output $stage failure inside the renderer',
  (fault) => {
    const scene = new Scene()
    const root = new Group()
    const material = new MeshStandardMaterial({ visible: false })
    const mesh = new Mesh(new BoxGeometry(), material)
    mesh.visible = false
    root.visible = false
    root.add(mesh)
    scene.add(root)
    const oldMaterial = new MeshStandardMaterial()
    let retired = 0
    oldMaterial.addEventListener('dispose', () => retired++)
    const oldActor = { root: new Group() }
    const actor = { root }
    const state = {
      scene,
      actor,
      warmed: oldActor,
      pending: null,
      retiredSkin: new Set([oldMaterial]),
    }
    Object.setPrototypeOf(state, ViewModel.prototype)
    const d = driver(scene, fault)
    try {
      d.fail(true)
      expect(() => Reflect.apply(ViewModel.prototype.warm, state, [d.warm])).toThrow(
        'actual driver failure',
      )
      expect(state.warmed).toBe(oldActor)
      expect(state.retiredSkin.size).toBe(1)
      expect(retired).toBe(0)
      expect(d.target).toBe(d.original)
      expect(root.visible || mesh.visible || material.visible).toBe(false)
      expect(mesh.frustumCulled).toBe(true)
      d.fail(false)
      Reflect.apply(ViewModel.prototype.warm, state, [d.warm])
      expect(d.outputs.slice(-2)).toEqual([null, d.composer])
      expect(state.warmed).toBe(actor)
      expect(state.retiredSkin.size).toBe(0)
      expect(retired).toBe(1)
      const count = d.outputs.length
      Reflect.apply(ViewModel.prototype.warm, state, [d.warm])
      expect(d.outputs.length).toBe(count)
    } finally {
      mesh.geometry.dispose()
      material.dispose()
      if (state.retiredSkin.has(oldMaterial)) {
        oldMaterial.dispose()
      }
    }
  },
)

it.each(faults)(
  'does not retire far programs after a $output $stage failure inside the renderer',
  (fault) => {
    const f = crowdFixture()
    const first = body()
    const next = body()
    const material = first.mesh.material as MeshStandardMaterial
    let retired = 0
    material.addEventListener('dispose', () => retired++)
    const look = lookFor([], 1)
    const vats = Reflect.get(f.crowd, 'vats') as Map<string, VatCrowd>
    const owners = Reflect.get(f.crowd, 'vatOwners') as Map<string, typeof look.look>
    const release = Reflect.get(f.crowd, 'releaseVariant') as (
      key: string,
      style: typeof look.look,
    ) => void
    const d = driver(f.scene, fault)
    f.members.set(1, { look, vatKey: 'old', actor: null })
    vats.set('old', first)
    owners.set('old', look.look)
    try {
      f.crowd.warmFar(d.warm)
      release.call(f.crowd, 'old', look.look)
      f.members.set(1, { look, vatKey: 'next', actor: null })
      vats.set('next', next)
      owners.set('next', look.look)
      next.mesh.count = 2
      next.mesh.visible = false
      next.mesh.frustumCulled = true
      const arrays = JSON.stringify(
        Object.values(next.mesh.geometry.attributes).map((a) => Array.from(a.array)),
      )
      d.fail(true)
      expect(() => f.crowd.warmFar(d.warm)).toThrow('actual driver failure')
      expect(retired).toBe(0)
      expect(next.warmReady).toBe(false)
      expect(next.mesh.count).toBe(2)
      expect(next.mesh.visible).toBe(false)
      expect(next.mesh.frustumCulled).toBe(true)
      expect(
        JSON.stringify(
          Object.values(next.mesh.geometry.attributes).map((a) => Array.from(a.array)),
        ),
      ).toBe(arrays)
      expect(d.target).toBe(d.original)
      d.fail(false)
      f.crowd.warmFar(d.warm)
      expect(d.outputs.slice(-2)).toEqual([null, d.composer])
      expect(next.warmReady).toBe(true)
      expect(retired).toBe(1)
      const count = d.outputs.length
      f.crowd.warmFar(d.warm)
      expect(d.outputs.length).toBe(count)
    } finally {
      f.dispose()
      for (const vat of [first, next]) {
        vat.bake.geometry.dispose()
        vat.bake.posTex.dispose()
        vat.bake.nrmTex.dispose()
      }
    }
  },
)
