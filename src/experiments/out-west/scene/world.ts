import {
  BackSide,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  type InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  PointLight,
  type Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
  Vector3,
} from 'three'
import { GeoBuilder } from './geo'
import { type Preset, presetAt } from './presets'
import { RIM } from './style'
import { clockCanvas, type SignSpec, signAtlas } from './textures'

/** Street layout (metres). The street runs along Z; the duel is centred on the origin. */
export const STREET = {
  half: 9,
  boardwalk: 2.4,
  churchZ: 64,
  posterPos: new Vector3(-8.2, 0, -2.5),
  /** The rifleman stands on the saloon's porch roof. */
  saloonRoof: new Vector3(10.4, 3.18, 6.2),
} as const

interface BuildingSpec {
  side: -1 | 1
  z: number
  w: number
  h: number
  front: number
  depth: number
  color: number
  sign: number
  kind?: 'saloon' | 'undertaker' | 'bank' | 'stable' | 'plain'
}

const SIGNS: SignSpec[] = [
  { text: 'SALOON', bg: '#6a1f14', fg: '#f3e2b8' },
  { text: 'GENERAL STORE', bg: '#2c3a2a', fg: '#efe0b0' },
  { text: 'SHERIFF', bg: '#1d2430', fg: '#e6c25a' },
  { text: 'UNDERTAKER', bg: '#141414', fg: '#d9d0bf' },
  { text: 'BANK', bg: '#3a2e1c', fg: '#e8cf7a' },
  { text: 'LIVERY STABLE', bg: '#5a3a22', fg: '#f0dcb0' },
  { text: 'HOTEL', bg: '#2a2236', fg: '#ead9b8' },
  { text: 'BARBER', bg: '#e9e2d0', fg: '#7a1a12' },
  { text: 'ASSAY OFFICE', bg: '#2b2b2b', fg: '#d8c9a4' },
  { text: 'POST OFFICE', bg: '#2e3b48', fg: '#efe6cf' },
  { text: 'GUNSMITH', bg: '#3b1c14', fg: '#f0d9a0' },
  { text: 'TELEGRAPH', bg: '#203028', fg: '#e8dcc0' },
]

const BUILDINGS: BuildingSpec[] = [
  // right side (+x), heading toward the church
  {
    side: 1,
    z: -46,
    w: 13,
    h: 5.2,
    front: 7.5,
    depth: 12,
    color: 0x8a6a4a,
    sign: 5,
    kind: 'stable',
  },
  { side: 1, z: -33, w: 9, h: 5.0, front: 7.4, depth: 10, color: 0xb8a690, sign: 10 },
  { side: 1, z: -22, w: 10, h: 5.5, front: 8.2, depth: 10, color: 0x9a8a72, sign: 4, kind: 'bank' },
  { side: 1, z: -10.5, w: 11, h: 5.2, front: 7.6, depth: 10, color: 0x7a8a7a, sign: 1 },
  { side: 1, z: 2, w: 12, h: 6.2, front: 8.4, depth: 12, color: 0x8a4a34, sign: 0, kind: 'saloon' },
  { side: 1, z: 15, w: 11, h: 7.2, front: 9.0, depth: 11, color: 0x9a8aa0, sign: 6 },
  { side: 1, z: 27, w: 8, h: 4.6, front: 6.6, depth: 9, color: 0xc0b49a, sign: 7 },
  { side: 1, z: 37, w: 10, h: 5.0, front: 7.0, depth: 10, color: 0x7a6a5a, sign: 11 },
  // left side (-x)
  { side: -1, z: -44, w: 12, h: 5.0, front: 7.2, depth: 10, color: 0x9a7a5a, sign: 8 },
  { side: -1, z: -31, w: 10, h: 5.4, front: 7.8, depth: 10, color: 0x6a7a8a, sign: 9 },
  { side: -1, z: -19.5, w: 10, h: 5.2, front: 7.6, depth: 10, color: 0x5a6070, sign: 2 },
  {
    side: -1,
    z: -6.5,
    w: 10,
    h: 5.0,
    front: 7.4,
    depth: 10,
    color: 0x4a443e,
    sign: 3,
    kind: 'undertaker',
  },
  { side: -1, z: 5.5, w: 11, h: 5.6, front: 8.0, depth: 11, color: 0xa08a6a, sign: 1 },
  { side: -1, z: 18, w: 11, h: 6.6, front: 8.6, depth: 11, color: 0x8a5a44, sign: 6 },
  { side: -1, z: 30, w: 10, h: 4.8, front: 6.8, depth: 10, color: 0xb0a080, sign: 10 },
]

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w;
}
`

const skyFrag = /* glsl */ `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float sunGlow;
uniform float stars;
uniform float moon;
uniform vec3 moonDir;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 col = mix(horizon, zenith, pow(smoothstep(-0.02, 0.55, h), 0.7));
  float s = max(dot(d, sunDir), 0.0);
  col += sunColor * (pow(s, 6.0) * 0.35 + pow(s, 64.0) * 0.6) * sunGlow;
  col += sunColor * smoothstep(0.9993, 0.9997, s) * 6.0 * step(0.0, sunDir.y) * (1.0 - moon);
  if (stars > 0.0) {
    vec3 q = floor(d * 380.0);
    float r = hash(q);
    float tw = step(0.9975, r) * smoothstep(0.02, 0.25, d.y);
    col += vec3(0.9, 0.95, 1.0) * tw * stars * (0.6 + 0.4 * hash(q + 7.0)) * 1.4;
  }
  if (moon > 0.0) {
    float m = max(dot(d, moonDir), 0.0);
    col += vec3(0.85, 0.9, 1.0) * smoothstep(0.99955, 0.99975, m) * 3.0 * moon;
    col += vec3(0.4, 0.5, 0.9) * pow(m, 40.0) * 0.25 * moon;
  }
  // below horizon fades into fog colour
  col = mix(col, horizon, smoothstep(0.0, -0.08, d.y));
  gl_FragColor = vec4(col, 1.0);
}
`

export interface Lantern {
  light: PointLight
  base: number
  phase: number
}

export class World {
  readonly root = new Group()
  readonly sun: DirectionalLight
  readonly hemi: HemisphereLight
  readonly fog: Fog
  readonly sky: Mesh
  private readonly skyMat: ShaderMaterial
  private readonly skyU = {
    zenith: { value: new Color() },
    horizon: { value: new Color() },
    sunDir: { value: new Vector3(0, 1, 0) },
    sunColor: { value: new Color() },
    sunGlow: { value: 0 },
    stars: { value: 0 },
    moon: { value: 0 },
    moonDir: { value: new Vector3(-0.4, 0.6, 0.7).normalize() },
  }
  readonly ground: Mesh
  readonly lanterns: Lantern[] = []
  readonly flashLight: PointLight
  readonly windowMat: MeshStandardMaterial
  readonly wallMat: MeshStandardMaterial
  readonly trimMat: MeshStandardMaterial
  readonly signMat: MeshStandardMaterial
  readonly clockMat: MeshStandardMaterial
  private readonly clock = clockCanvas()
  private readonly clockTex: CanvasTexture
  readonly glintAnchor = new Group()
  readonly poster: Group
  posterMat: MeshStandardMaterial
  preset: Preset
  day = 0
  /** Things to hide on the red silhouette frame. */
  readonly silhouetteHide: Object3D[] = []
  readonly instanced: InstancedMesh[] = []
  readonly saloonDoors: Mesh[] = []
  private time = 0
  readonly bellPos = new Vector3(0, 13, STREET.churchZ - 6)

  constructor(
    scene: Scene,
    tex: {
      ground: Texture
      groundN: Texture
      planks: Texture
      planksN: Texture
      vplanks: Texture
      vplanksN: Texture
    },
    shadowSize: number,
  ) {
    scene.add(this.root)
    this.preset = presetAt(0)
    this.fog = new Fog(0xe8d3a8, 60, 220)
    scene.fog = this.fog

    // --- lights
    this.hemi = new HemisphereLight(0xcfe0ff, 0xb08a5a, 1)
    this.root.add(this.hemi)
    this.sun = new DirectionalLight(0xfff1d6, 3.2)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(shadowSize, shadowSize)
    const sc = this.sun.shadow.camera
    sc.left = -20
    sc.right = 20
    sc.top = 20
    sc.bottom = -20
    sc.near = 1
    sc.far = 120
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.03
    this.root.add(this.sun)
    this.root.add(this.sun.target)

    // Lantern lights on the porches nearest the duel (no shadows: one shadow caster only).
    const lanternSpots: [number, number, number][] = [
      [-9.4, 3.0, -10],
      [9.4, 3.0, -4],
      [-9.4, 3.0, 2],
      [9.4, 3.0, 9],
      [-9.4, 3.0, 13],
      [9.4, 3.0, 20],
    ]
    for (const [x, y, z] of lanternSpots) {
      const l = new PointLight(0xffa850, 0, 16, 1.6)
      l.position.set(x, y, z)
      this.root.add(l)
      this.lanterns.push({ light: l, base: 20, phase: Math.random() * 10 })
    }
    this.flashLight = new PointLight(0xffd090, 0, 14, 1.5)
    this.root.add(this.flashLight)

    // --- sky
    this.skyMat = new ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: this.skyU,
    })
    this.sky = new Mesh(new SphereGeometry(900, 32, 16), this.skyMat)
    this.sky.frustumCulled = false
    this.sky.renderOrder = -1
    this.root.add(this.sky)
    this.silhouetteHide.push(this.sky)

    // --- materials
    this.wallMat = new MeshStandardMaterial({
      map: tex.planks,
      normalMap: tex.planksN,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0,
      color: new Color(1.7, 1.6, 1.5),
    })
    this.trimMat = new MeshStandardMaterial({
      map: tex.vplanks,
      normalMap: tex.vplanksN,
      vertexColors: true,
      roughness: 0.95,
      color: new Color(1.5, 1.45, 1.4),
    })
    this.windowMat = new MeshStandardMaterial({
      color: 0x1a1612,
      roughness: 0.25,
      metalness: 0.2,
      emissive: new Color(0xff9a40),
      emissiveIntensity: 0,
    })
    const atlas = signAtlas(SIGNS)
    this.signMat = new MeshStandardMaterial({ map: atlas.tex, roughness: 0.85 })
    this.clockTex = new CanvasTexture(this.clock.canvas)
    this.clockTex.colorSpace = SRGBColorSpace
    this.clockMat = new MeshStandardMaterial({
      map: this.clockTex,
      emissiveMap: this.clockTex,
      emissive: new Color(0xffe0a0),
      emissiveIntensity: 0,
      roughness: 0.6,
    })

    // --- ground
    const groundMat = new MeshStandardMaterial({
      map: tex.ground,
      normalMap: tex.groundN,
      roughness: 1,
      color: 0xd8c0a0,
    })
    groundMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldP;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vWorldP;
float gh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gn(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(gh(i),gh(i+vec2(1,0)),f.x), mix(gh(i+vec2(0,1)),gh(i+vec2(1,1)),f.x), f.y); }`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
{
  float macro = gn(vWorldP.xz * 0.04) * 0.6 + gn(vWorldP.xz * 0.13) * 0.4;
  diffuseColor.rgb *= mix(0.78, 1.12, macro);
  float ax = abs(vWorldP.x);
  float rut = exp(-pow((ax - 1.25) * 5.0, 2.0)) * (0.6 + 0.4 * gn(vWorldP.xz * vec2(2.0, 0.3)));
  diffuseColor.rgb *= 1.0 - rut * 0.22 * step(vWorldP.z, 58.0);
  float street = 1.0 - smoothstep(8.5, 11.0, ax);
  diffuseColor.rgb *= mix(1.04, 0.96, street);
}`,
        )
    }
    tex.ground.repeat.set(1, 1)
    const gGeo = new PlaneGeometry(700, 700, 1, 1)
    gGeo.rotateX(-Math.PI / 2)
    const uv = gGeo.getAttribute('uv')
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 175, uv.getY(i) * 175)
    this.ground = new Mesh(gGeo, groundMat)
    this.ground.receiveShadow = true
    this.ground.matrixAutoUpdate = false
    this.ground.updateMatrix()
    this.root.add(this.ground)
    this.silhouetteHide.push(this.ground)

    this.buildTown(atlas.rows)
    this.buildChurch()
    this.buildWaterTower()
    this.buildMesas()
    this.poster = this.buildPosterPost()
    this.posterMat =
      (this.poster.userData['mat'] as MeshStandardMaterial) ?? new MeshStandardMaterial()

    this.apply(0)
  }

  private addStatic(geo: GeoBuilder, mat: MeshStandardMaterial, shadow = true): Mesh | null {
    if (geo.empty) return null
    const m = new Mesh(geo.build(), mat)
    m.castShadow = shadow
    m.receiveShadow = true
    m.matrixAutoUpdate = false
    m.updateMatrix()
    this.root.add(m)
    return m
  }

  private buildTown(signRows: number): void {
    const walls = new GeoBuilder(1.9)
    const trim = new GeoBuilder(1.6)
    const glass = new GeoBuilder(1)
    const signs = new GeoBuilder(1)
    const H = STREET.half
    const BW = STREET.boardwalk
    const white = new Color(0xffffff)
    for (const b of BUILDINGS) {
      const s = b.side
      const paint = new Color(b.color).lerp(white, 0.5).getHex()
      const fx = s * (H + BW) // facade plane
      const z0 = b.z - b.w / 2
      const z1 = b.z + b.w / 2
      const bodyCx = fx + (s * b.depth) / 2
      // main body
      walls.box(bodyCx, b.h / 2, b.z, b.depth, b.h, b.w - 0.05, paint, { skip: ['bottom'] })
      // roof: shallow gable running away from the street, hidden by the false front
      trim.gable(bodyCx, b.h, b.z, b.depth, b.w - 0.3, 1.2, 'x', 0x4a3a2e, 0.2)
      // false front (taller flat facade)
      const ft = 0.25
      walls.box(fx - (s * ft) / 2, b.front / 2, b.z, ft, b.front, b.w, paint, {
        skip: ['bottom'],
      })
      // cornice
      trim.box(fx - s * 0.35, b.front + 0.12, b.z, 0.6, 0.24, b.w + 0.3, 0x3a2a1e)
      trim.box(fx - s * 0.2, b.front - 0.4, b.z, 0.3, 0.12, b.w + 0.1, 0x3a2a1e)
      // corner pilasters
      trim.box(fx - s * 0.3, b.front / 2, z0 + 0.15, 0.3, b.front, 0.3, 0x3a2a1e)
      trim.box(fx - s * 0.3, b.front / 2, z1 - 0.15, 0.3, b.front, 0.3, 0x3a2a1e)
      // sign board on the false front
      const sy = b.h + (b.front - b.h) * 0.45 + 0.3
      const sw = Math.min(b.w - 1.4, 8.5)
      const sh = 1.0
      const row = b.sign
      const v0 = 1 - (row + 1) / signRows
      const v1 = 1 - row / signRows
      const sx = fx - s * 0.32
      const V = (x: number, y: number, z: number) => new Vector3(x, y, z)
      if (s === 1) {
        signs.quadUV(
          [
            V(sx, sy - sh / 2, b.z + sw / 2),
            V(sx, sy - sh / 2, b.z - sw / 2),
            V(sx, sy + sh / 2, b.z - sw / 2),
            V(sx, sy + sh / 2, b.z + sw / 2),
          ],
          [0, v0, 1, v0, 1, v1, 0, v1],
          0xffffff,
        )
      } else {
        signs.quadUV(
          [
            V(sx, sy - sh / 2, b.z - sw / 2),
            V(sx, sy - sh / 2, b.z + sw / 2),
            V(sx, sy + sh / 2, b.z + sw / 2),
            V(sx, sy + sh / 2, b.z - sw / 2),
          ],
          [0, v0, 1, v0, 1, v1, 0, v1],
          0xffffff,
        )
      }
      trim.box(fx - s * 0.28, sy, b.z, 0.08, sh + 0.2, sw + 0.2, 0x2a1d14)
      // upper windows on the false front
      const upper = b.h > 5.4 ? 2 : 0
      for (let i = 0; i < upper; i++) {
        const wz = b.z + (i === 0 ? -1 : 1) * (b.w / 4)
        glass.box(fx - s * 0.28, b.h - 1.2, wz, 0.06, 1.3, 0.9, 0xffffff)
        trim.box(fx - s * 0.3, b.h - 1.2, wz, 0.08, 1.5, 1.1, 0xd8ccb0)
      }
      // ground floor: door + two windows
      const doorW = b.kind === 'stable' ? 3.2 : 1.4
      glass.box(fx - s * 0.27, 1.25, b.z, 0.06, 2.5, doorW, 0xffffff)
      trim.box(fx - s * 0.29, 1.3, b.z, 0.08, 2.7, doorW + 0.3, 0x2a1d14)
      for (const dz of [-1, 1]) {
        const wz = b.z + dz * (b.w / 2 - 1.8)
        glass.box(fx - s * 0.28, 1.7, wz, 0.06, 1.6, 1.8, 0xffffff)
        trim.box(fx - s * 0.3, 1.7, wz, 0.08, 1.85, 2.05, 0xd8ccb0)
        trim.box(fx - s * 0.32, 0.86, wz, 0.25, 0.1, 2.2, 0x3a2a1e)
      }
      // boardwalk
      trim.box(s * (H + BW / 2), 0.17, b.z, BW, 0.34, b.w, 0xc8b090, { rotUV: true })
      // awning on posts
      const aw = 3.1
      trim.box(s * (H + BW / 2 + 0.1), aw, b.z, BW + 0.4, 0.12, b.w, 0x5a4634)
      for (
        let pz = z0 + 0.3;
        pz <= z1 - 0.2;
        pz += (b.w - 0.6) / Math.max(1, Math.round(b.w / 3.2))
      ) {
        trim.box(s * (H + 0.15), aw / 2 + 0.17, pz, 0.18, aw - 0.3, 0.18, 0x4a3828)
      }
      // hitching post
      if (b.kind !== 'undertaker') {
        const hz = b.z + (b.side === 1 ? 2 : -2)
        trim.box(s * (H - 0.6), 0.5, hz - 1.2, 0.14, 1.0, 0.14, 0x5a4430)
        trim.box(s * (H - 0.6), 0.5, hz + 1.2, 0.14, 1.0, 0.14, 0x5a4430)
        trim.box(s * (H - 0.6), 0.95, hz, 0.1, 0.1, 2.6, 0x5a4430)
      }
      // saloon swinging doors
      if (b.kind === 'saloon') {
        for (const dz of [-0.36, 0.36]) {
          const g = new GeoBuilder(1.6)
          g.box(0, 0, dz * 1, 0.05, 1.1, 0.68, 0x7a4a2a)
          const door = new Mesh(g.build(), this.trimMat)
          door.position.set(fx - s * 0.4, 1.35, b.z + dz)
          door.castShadow = true
          this.root.add(door)
          this.saloonDoors.push(door)
        }
      }
    }
    // a water trough and a few fence runs at the open end
    trim.box(-8.2, 0.35, 10, 0.9, 0.7, 2.4, 0x5a4430)
    trim.box(8.3, 0.35, -16, 0.9, 0.7, 2.4, 0x5a4430)

    this.addStatic(walls, this.wallMat)
    this.addStatic(trim, this.trimMat)
    const gm = this.addStatic(glass, this.windowMat, false)
    if (gm) gm.receiveShadow = false
    this.addStatic(signs, this.signMat, false)
  }

  private buildChurch(): void {
    const w = new GeoBuilder(1.9)
    const t = new GeoBuilder(1.6)
    const cz = STREET.churchZ
    const white = 0xf4efe6
    // nave
    w.box(0, 3.6, cz + 9, 11, 7.2, 18, white, { skip: ['bottom'] })
    t.gable(0, 7.2, cz + 9, 11, 18, 4.2, 'z', 0x3a3438, 0.5)
    // tower
    w.box(0, 7, cz - 1, 4.4, 14, 4.4, white, { skip: ['bottom'] })
    // belfry
    t.box(0, 15.1, cz - 1, 4.6, 0.3, 4.6, 0x3a2a20)
    for (const [dx, dz] of [
      [-2, -2],
      [2, -2],
      [-2, 2],
      [2, 2],
    ] as const) {
      t.box(dx, 16.5, cz - 1 + dz, 0.4, 2.6, 0.4, white)
    }
    t.box(0, 17.95, cz - 1, 4.8, 0.3, 4.8, 0x3a2a20)
    t.pyramid(0, 18.1, cz - 1, 4.8, 6.5, 0x2e2a2e)
    // cross
    t.box(0, 25.4, cz - 1, 0.16, 1.6, 0.16, 0x2a2a2a)
    t.box(0, 25.7, cz - 1, 0.16, 0.16, 0.9, 0x2a2a2a)
    // door + steps
    t.box(0, 1.6, cz - 3.25, 1.8, 3.2, 0.1, 0x2a1a12)
    t.box(0, 0.15, cz - 4, 4, 0.3, 1.6, 0x8a7a68)
    this.addStatic(w, this.wallMat)
    this.addStatic(t, this.trimMat)
    // bell
    const bell = new Mesh(
      new SphereGeometry(0.75, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
      new MeshStandardMaterial({ color: 0x8a6a2a, metalness: 0.8, roughness: 0.35 }),
    )
    bell.position.set(0, 16.9, cz - 1)
    bell.rotation.x = Math.PI
    bell.position.y += 0.6
    this.root.add(bell)
    this.bellPos.copy(bell.position)
    // clock face
    const face = new Mesh(new PlaneGeometry(2.6, 2.6), this.clockMat)
    face.position.set(0, 12.2, cz - 3.22)
    face.rotation.y = Math.PI
    this.root.add(face)
    // round rim via alpha: draw with transparent corners
    this.clockMat.transparent = true
    this.clockMat.alphaTest = 0.5
  }

  setClock(h: number, m: number): void {
    this.clock.draw(h, m)
    this.clockTex.needsUpdate = true
  }

  private buildWaterTower(): void {
    const t = new GeoBuilder(1.4)
    const x = 26
    const z = 24
    for (const [dx, dz] of [
      [-2, -2],
      [2, -2],
      [-2, 2],
      [2, 2],
    ] as const) {
      t.box(x + dx, 4.5, z + dz, 0.35, 9, 0.35, 0x5a4430)
    }
    t.box(x, 3, z - 2, 4, 0.2, 0.2, 0x5a4430)
    t.box(x, 3, z + 2, 4, 0.2, 0.2, 0x5a4430)
    t.box(x - 2, 3, z, 0.2, 0.2, 4, 0x5a4430)
    t.box(x + 2, 3, z, 0.2, 0.2, 4, 0x5a4430)
    t.box(x, 9.1, z, 5, 0.25, 5, 0x4a3828)
    this.addStatic(t, this.trimMat)
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
      tank.quad(p1, p0, p3, p2, 0x7a5e44, true)
      const top = new Vector3(x, 14, z)
      tank.tri(p2, p3, top, 0x3a2e26)
    }
    this.addStatic(tank, this.trimMat)
  }

  private buildMesas(): void {
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
    for (const [x, z, r, h] of spots) mesa(x * 1.25, z * 1.25, r, h * 0.55, 0x9a5a3a)
    const m = new MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true })
    const mesh = this.addStatic(g, m, false)
    if (mesh) mesh.receiveShadow = false
  }

  private buildPosterPost(): Group {
    const g = new Group()
    const post = new GeoBuilder(1.2)
    post.box(0, 1.4, 0, 0.22, 2.8, 0.22, 0x5a4430)
    const pm = new Mesh(post.build(), this.trimMat)
    pm.castShadow = true
    g.add(pm)
    const mat = new MeshStandardMaterial({
      roughness: 0.9,
      emissive: 0xffffff,
      emissiveIntensity: 0.28,
    })
    const paper = new Mesh(new PlaneGeometry(0.62, 0.86), mat)
    paper.position.set(0.12, 1.75, 0)
    paper.rotation.y = Math.PI / 2
    paper.castShadow = true
    g.add(paper)
    g.userData['mat'] = mat
    g.userData['paper'] = paper
    g.position.copy(STREET.posterPos)
    this.root.add(g)
    return g
  }

  /** Recompute everything that depends on time of day. */
  apply(day: number): void {
    this.day = day
    const p = presetAt(day)
    this.preset = p
    const el = (p.sunElev * Math.PI) / 180
    const az = (p.sunAz * Math.PI) / 180
    const dir = new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    const lightDir = dir.clone()
    if (lightDir.y < 0.12) lightDir.y = 0.12
    lightDir.normalize()
    this.sun.position.copy(lightDir).multiplyScalar(60)
    this.sun.target.position.set(0, 0, 0)
    this.sun.color.copy(p.sunColor)
    this.sun.intensity = p.sunIntensity
    this.hemi.color.copy(p.hemiSky)
    this.hemi.groundColor.copy(p.hemiGround)
    this.hemi.intensity = p.hemiIntensity
    this.fog.color.copy(p.fog)
    this.fog.near = p.fogNear
    this.fog.far = p.fogFar
    const u = this.skyU
    u.zenith.value.copy(p.zenith)
    u.horizon.value.copy(p.fog)
    u.sunDir.value.copy(dir)
    u.sunColor.value.copy(p.sunColor)
    u.sunGlow.value = p.sunGlow
    u.stars.value = p.stars
    u.moon.value = p.moon
    if (p.moon > 0.5) u.moonDir.value.copy(dir)
    RIM.color.value.copy(p.rimColor)
    RIM.strength.value = p.rim
    this.windowMat.emissiveIntensity = p.windows * 1.6
    this.clockMat.emissiveIntensity = day > 0.95 ? (day - 0.95) * 20 * 0.9 : 0
  }

  /** Fog thickening for the windy outlaw (0..1). */
  windyFog(amount: number): void {
    const p = this.preset
    this.fog.near = p.fogNear * (1 - amount * 0.75)
    this.fog.far = p.fogFar * (1 - amount * 0.7)
  }

  /** Two lanterns become fires for the underboss. */
  fires = false

  update(dt: number): void {
    this.time += dt
    const lv = this.preset.lanterns
    for (const l of this.lanterns) {
      const f =
        0.85 +
        Math.sin(this.time * 9 + l.phase) * 0.06 +
        Math.sin(this.time * 23 + l.phase * 2) * 0.05
      l.light.intensity = lv * l.base * f
    }
    if (this.fires) {
      for (const i of [1, 2]) {
        const l = this.lanterns[i]
        if (!l) continue
        l.light.intensity = 26 * (0.7 + Math.random() * 0.4)
        l.light.color.setHex(0xff7a30)
      }
    }
    const sway = Math.sin(this.time * 1.7) * 0.08
    this.saloonDoors.forEach((d, i) => {
      d.rotation.y = (i === 0 ? 1 : -1) * sway * (d.userData['kick'] ? 6 : 1)
    })
  }

  /** Set the fire state (underboss). */
  setFires(on: boolean): void {
    this.fires = on
    if (!on) for (const l of this.lanterns) l.light.color.setHex(0xffa850)
  }

  /** Shadow frustum tightly around the action. */
  focusShadow(center: Vector3): void {
    const dir = this.sun.position.clone().normalize()
    this.sun.target.position.copy(center)
    this.sun.position.copy(center).addScaledVector(dir, 60)
  }
}
