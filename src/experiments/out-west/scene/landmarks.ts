// biome-ignore-all lint/complexity/useMaxParams: geometry builders take positional numeric args (x, z, r, h, colour), mirroring three.js APIs
/**
 * Static scenery merged into single meshes: the helper that adds one, the water tower and the mesas
 * on the horizon.
 */
import { Group, Mesh, MeshStandardMaterial, type Object3D, PlaneGeometry, Vector3 } from 'three'
import { GeoBuilder } from './geo.ts'
import { STREET } from './street.ts'

/** One merged, static mesh (no per-frame matrix updates); null when the builder is empty. */
export function addStatic(
  root: Object3D,
  geo: GeoBuilder,
  mat: MeshStandardMaterial,
  shadow = true,
): Mesh | null {
  if (geo.empty) {
    return null
  }
  const m = new Mesh(geo.build(), mat)
  m.castShadow = shadow
  m.receiveShadow = true
  m.matrixAutoUpdate = false
  m.updateMatrix()
  root.add(m)
  return m
}

/** The water tower off the street's east side: four legs, braces, a stave tank and its cap. */
export function buildWaterTower(root: Object3D, trimMat: MeshStandardMaterial): void {
  const t = new GeoBuilder(1.4)
  const x = 26
  const z = 24
  for (const [dx, dz] of [
    [-2, -2],
    [2, -2],
    [-2, 2],
    [2, 2],
  ] as const) {
    t.box(x + dx, 4.5, z + dz, 0.35, 9, 0.35, 0x5a_44_30)
  }
  t.box(x, 3, z - 2, 4, 0.2, 0.2, 0x5a_44_30)
  t.box(x, 3, z + 2, 4, 0.2, 0.2, 0x5a_44_30)
  t.box(x - 2, 3, z, 0.2, 0.2, 4, 0x5a_44_30)
  t.box(x + 2, 3, z, 0.2, 0.2, 4, 0x5a_44_30)
  t.box(x, 9.1, z, 5, 0.25, 5, 0x4a_38_28)
  addStatic(root, t, trimMat)
  // tank: octagonal stave cylinder
  const tank = new GeoBuilder(1.4)
  const r = 2.6
  const n = 12
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2
    const a1 = ((i + 1) / n) * Math.PI * 2
    const p0 = new Vector3(x + Math.cos(a0) * r, 9.2, z + Math.sin(a0) * r)
    const p1 = new Vector3(x + Math.cos(a1) * r, 9.2, z + Math.sin(a1) * r)
    const p2 = p1.clone().setY(12.6)
    const p3 = p0.clone().setY(12.6)
    tank.quad(p1, p0, p3, p2, 0x7a_5e_44, true)
    const top = new Vector3(x, 14, z)
    tank.tri(p2, p3, top, 0x3a_2e_26)
  }
  addStatic(root, tank, trimMat)
}

/** Mesas ringing the horizon (unlit by shadows, flat shaded). */
export function buildMesas(root: Object3D): void {
  const g = new GeoBuilder(30)
  const rnd = (a: number, b: number) => a + Math.random() * (b - a)
  const mesa = (cx: number, cz: number, r: number, h: number, color: number) => {
    const n = 9
    const pts: Vector3[] = []
    const top: Vector3[] = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      const rr = r * rnd(0.75, 1.15)
      pts.push(new Vector3(cx + Math.cos(a) * rr, -2, cz + Math.sin(a) * rr * 0.6))
      top.push(
        new Vector3(
          cx + Math.cos(a) * rr * rnd(0.6, 0.75),
          h * rnd(0.92, 1.05),
          cz + Math.sin(a) * rr * 0.45,
        ),
      )
    }
    const c = new Vector3(cx, h, cz)
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      g.quad(pts[j] as Vector3, pts[i] as Vector3, top[i] as Vector3, top[j] as Vector3, color)
      g.tri(top[j] as Vector3, top[i] as Vector3, c, color)
    }
  }
  const spots: [number, number, number, number][] = [
    [-60, -175, 38, 34],
    [10, -205, 55, 46],
    [85, -185, 30, 28],
    [-140, -140, 40, 30],
    [150, -120, 35, 40],
    [-175, -20, 30, 26],
    [180, 40, 40, 32],
    [-150, 120, 50, 36],
    [120, 170, 40, 30],
  ]
  for (const [x, z, r, h] of spots) {
    mesa(x * 1.25, z * 1.25, r, h * 0.55, 0x9a_5a_3a)
  }
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true })
  const mesh = addStatic(root, g, m, false)
  if (mesh) {
    mesh.receiveShadow = false
  }
}

/** The wanted-poster post at the street's edge; its paper's material is in `userData`. */
export function buildPosterPost(root: Object3D, trimMat: MeshStandardMaterial): Group {
  const g = new Group()
  const post = new GeoBuilder(1.2)
  post.box(0, 1.4, 0, 0.22, 2.8, 0.22, 0x5a_44_30)
  const pm = new Mesh(post.build(), trimMat)
  pm.castShadow = true
  g.add(pm)
  const mat = new MeshStandardMaterial({
    roughness: 0.9,
    emissive: 0xff_ff_ff,
    emissiveIntensity: 0.28,
  })
  const paper = new Mesh(new PlaneGeometry(0.62, 0.86), mat)
  paper.position.set(0.12, 1.75, 0)
  paper.rotation.y = Math.PI / 2
  paper.castShadow = true
  g.add(paper)
  g.userData.mat = mat
  g.userData.paper = paper
  g.position.copy(STREET.posterPos)
  root.add(g)
  return g
}
