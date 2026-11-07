import { expect, it } from 'bun:test'
import { MeshStandardMaterial, PerspectiveCamera, Vector2, Vector3 } from 'three'
import { FrontierGame } from '../src/experiments/out-west/ffa/client/game.ts'
import { CUT, cutaway } from '../src/experiments/out-west/ffa/scene/cutaway.ts'

it('clears a death aperture around the full physical body and restores ordinary living/first-person rules', () => {
  const camera = new PerspectiveCamera(72, 1.6, 0.1, 200)
  camera.position.set(2, 2, 10)
  camera.lookAt(2, 0.4, 3)
  camera.updateMatrixWorld(true)
  const state = {
    settings: { view: 'third' },
    net: { alive: false, you: 0 },
    ragdolls: { focus: (_id: number, out: Vector3) => out.set(2, 0.4, 3), radius: () => 1.8 },
    corpseFocus: new Vector3(),
    tmp: new Vector3(),
    cutView: new Vector3(),
    cutSize: new Vector2(),
    own: { x: 2, y: 0, z: 3 },
    cam: { camera, distance: 15 },
    renderer: { gl: { getDrawingBufferSize: (out: Vector2) => out.set(1280, 800) } },
  }
  const update = () => Reflect.apply(Reflect.get(FrontierGame.prototype, 'updateCut'), state, [])
  try {
    update()
    const deathRadius = CUT.radius.value
    expect(CUT.clean.value).toBe(1)
    expect(deathRadius).toBeGreaterThan(0)
    state.net.alive = true
    update()
    expect(CUT.clean.value).toBe(0)
    expect(CUT.radius.value).toBeLessThan(deathRadius)
    state.settings.view = 'first'
    update()
    expect(CUT.clean.value).toBe(0)
    expect(CUT.radius.value).toBe(0)
  } finally {
    CUT.radius.value = 0
    CUT.clean.value = 0
  }
})

it('connects the clean aperture policy to the real patched town fragment program', () => {
  const material = new MeshStandardMaterial()
  cutaway(material, false)
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <worldpos_vertex>',
    fragmentShader: '#include <common>\n#include <clipping_planes_fragment>',
  }
  Reflect.apply(material.onBeforeCompile, material, [shader, {}])
  expect(Reflect.get(shader.uniforms, 'cutClean')).toBe(CUT.clean)
  expect(shader.fragmentShader).toContain('cutRadius - 1.5')
  expect(shader.fragmentShader).toContain('coverage * nearer')
  material.dispose()
})
