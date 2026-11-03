import type { InstancedMesh, Matrix4, Object3D } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { instance, placeMatrix, propDef } from './props'

const r = (a: number, b: number) => a + Math.random() * (b - a)

/** Instanced props around the street. Returns the coffin instances (count changes with kills). */
export function dressStreet(props: GLTF, parent: Object3D): { coffins: InstancedMesh[] } {
  const add = (
    name: string,
    size: number,
    mats: Matrix4[],
    shadow = true,
    axis: 'max' | 'y' = 'max',
    cap?: number,
  ) => {
    const def = propDef(props, name, size, axis)
    return def ? instance(def, mats, parent, shadow, cap) : []
  }

  // barrels and crates on and by the boardwalks
  const barrels: Matrix4[] = []
  const crates: Matrix4[] = []
  const spots: [number, number][] = [
    [10.2, -14.5],
    [10.4, -13.6],
    [-10.3, 9.6],
    [10.3, 20.6],
    [-10.4, -24],
    [9.8, -27.5],
    [-9.9, 23.4],
    [10.1, 31.5],
    [-10.2, -36.5],
  ]
  for (const [x, z] of spots)
    barrels.push(placeMatrix(x, x > 0 ? 0.34 : 0.34, z, r(0, 6), r(0.95, 1.1)))
  barrels.push(placeMatrix(-8.3, 0, -15.5, 0.4), placeMatrix(8.4, 0, 25.2, 1.1))
  for (const [x, z] of [
    [10.6, -12.6],
    [-10.6, 10.8],
    [10.4, 21.8],
    [-10.6, 24.5],
    [10.6, -37],
    [-10.5, -23],
  ] as const)
    crates.push(placeMatrix(x, 0.34, z, r(-0.3, 0.3), r(0.9, 1.1)))
  crates.push(placeMatrix(8.6, 0, 26.2, 0.3))
  add('barrel', 1.0, barrels, true, 'y')
  add('crate', 0.85, crates, true, 'y')
  // hay at the livery
  add(
    'hay',
    1.3,
    [placeMatrix(8.6, 0, -42, 0.2), placeMatrix(8.4, 0, -44, 1.3), placeMatrix(-8.4, 0, 35, 0.6)],
    true,
    'y',
  )
  // broken cart near the end of the street
  add('cart', 4.2, [placeMatrix(-7.6, 0, -30, 0.5), placeMatrix(7, 0, 42, 2.2)])
  // cacti and rocks out in the desert and at the open end
  const cacti: Matrix4[] = []
  for (let i = 0; i < 26; i++) {
    const side = Math.random() < 0.5 ? -1 : 1
    const z = r(-140, 60)
    const x = z < -60 ? r(-60, 60) : side * r(24, 80)
    if (z < -55 && Math.abs(x) < 10) continue
    cacti.push(placeMatrix(x, 0, z, r(0, 6), r(2.5, 4.6), 0, 0))
  }
  add('cactus', 1, cacti, false, 'y')
  const rocks: Matrix4[] = []
  for (let i = 0; i < 14; i++) {
    const side = Math.random() < 0.5 ? -1 : 1
    rocks.push(placeMatrix(side * r(28, 90), -0.2, r(-150, 80), r(0, 6), r(2, 7)))
  }
  add('rock', 1, rocks, false, 'y')
  // fence runs out past the stable
  const fence: Matrix4[] = []
  for (let i = 0; i < 6; i++) fence.push(placeMatrix(22, 0, -52 + i * 5.9, Math.PI / 2))
  for (let i = 0; i < 5; i++) fence.push(placeMatrix(-22, 0, -48 + i * 5.9, Math.PI / 2))
  add('fence', 5.9, fence, true, 'max')
  // hanging lanterns at the lantern lights
  add(
    'lantern',
    0.45,
    [
      placeMatrix(-9.4, 2.6, -10, 0),
      placeMatrix(9.4, 2.6, -4, 0),
      placeMatrix(-9.4, 2.6, 2, 0),
      placeMatrix(9.4, 2.6, 9, 0),
      placeMatrix(-9.4, 2.6, 13, 0),
      placeMatrix(9.4, 2.6, 20, 0),
    ],
    false,
    'y',
  )
  // coffins stood against the undertaker's front, one per kill
  const coffinMats: Matrix4[] = []
  for (let i = 0; i < 18; i++) {
    const z = -10.6 + i * 0.62
    coffinMats.push(placeMatrix(-11.2, 0.35, z, Math.PI / 2, 1, -Math.PI / 2 + 0.22, 0))
  }
  const coffins = add('coffin', 1.9, coffinMats, true, 'max', 18)
  for (const c of coffins) c.count = 2
  return { coffins }
}
