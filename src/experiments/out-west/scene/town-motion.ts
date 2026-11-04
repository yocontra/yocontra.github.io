// biome-ignore-all lint/style/noExcessiveClassesPerFile: the street's small moving things kept together
/**
 * Small motion on the street: a screen door that bangs, hanging shingle signs that swing on their chains in the wind (one
 * draw for both, on the rigid-part rig), and dust devils, a twisting column of grit that wanders
 * across the far street now and then (one point draw).
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  type Group,
  Matrix4,
  Mesh,
  type MeshStandardMaterial,
  NormalBlending,
  Points,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  Vector3,
} from 'three'
import { PartBuilder, placed, RIG_TIME, RigHerd, rigMaterial } from './critter-rig.ts'
import { AWNING } from './street.ts'

interface Shingle {
  text: string
  x: number
  z: number
  bg: string
  fg: string
}

/** Under the porch roofs, near the front edge, boards across the boardwalk (read up the street). */
const SHINGLES: readonly Shingle[] = [
  { text: 'SALOON', x: 9.75, z: 6.6, bg: '#5a1a12', fg: '#f0dcae' },
  { text: 'ROOMS', x: -9.75, z: 13.2, bg: '#2a2236', fg: '#ead9b8' },
]
const BOARD_W = 1.0
const BOARD_H = 0.42
const CHAIN = 0.36

/** anim: x phase (per part through the vertex pivot), y gust. One part per sign. */
const SIGN_GLSL = /* glsl */ `
float partAngle(float part, float t, vec4 anim) {
  float ph = part * 2.3;
  return 0.07 * sin(t * 1.25 + ph) + 0.04 * sin(t * 2.9 + ph * 1.7) + anim.y * 0.18 * sin(t * 3.4 + ph);
}
`

function signTexture(): Texture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 64 * SHINGLES.length
  const ctx = c.getContext('2d')
  if (ctx) {
    SHINGLES.forEach((s, i) => {
      const y = i * 64
      ctx.fillStyle = s.bg
      ctx.fillRect(0, y, 256, 64)
      // weathered board grain
      for (let k = 0; k < 40; k++) {
        ctx.fillStyle = `rgba(0,0,0,${(0.04 + Math.random() * 0.08).toFixed(2)})`
        ctx.fillRect(0, y + Math.random() * 64, 256, 1 + Math.random() * 2)
      }
      ctx.strokeStyle = s.fg
      ctx.lineWidth = 3
      ctx.strokeRect(6, y + 6, 244, 52)
      ctx.fillStyle = s.fg
      ctx.font = 'bold 34px Georgia, serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(s.text, 128, y + 34)
    })
  }
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  t.anisotropy = 4
  return t
}

/** The board's UVs to its row of the atlas (both faces read the right way round). */
function boardUv(g: BufferGeometry, row: number): void {
  const uv = g.getAttribute('uv')
  const n = SHINGLES.length
  for (let i = 0; i < uv.count; i++) {
    uv.setY(i, 1 - (row + 1 - uv.getY(i)) / n)
  }
}

export class Shingles {
  readonly mesh: Mesh
  private readonly mat: MeshStandardMaterial

  constructor(root: Group) {
    const b = new PartBuilder()
    const boards: BufferGeometry[] = []
    SHINGLES.forEach((s, i) => {
      const top = AWNING
      const hinge = { part: i, pivot: [s.x, top, s.z] as const, axis: [1, 0, 0] as const }
      const y = top - CHAIN - BOARD_H / 2
      // the board: textured faces toward ±z (up and down the street)
      const board = placed(new BoxGeometry(BOARD_W, BOARD_H, 0.04), [s.x, y, s.z])
      boardUv(board, i)
      boards.push(board)
      for (const dx of [-0.4, 0.4]) {
        b.add(
          placed(new CylinderGeometry(0.006, 0.006, CHAIN, 4), [s.x + dx, top - CHAIN / 2, s.z]),
          0x2a_26_22,
          hinge,
        )
      }
    })
    // chains share the rig; the boards ride the same hinges, keeping their UVs
    const rig = b.build()
    const parts = SHINGLES.map((s, i) => tagBoard(boards[i] ?? new BufferGeometry(), i, s))
    this.mat = rigMaterial('sign', SIGN_GLSL, [2, 40, 2], 0.85)
    this.mat.map = signTexture()
    this.mesh = new Mesh(mergeWithUv([rig, ...parts]), this.mat)
    this.mesh.name = 'shingles'
    this.mesh.castShadow = false
    root.add(this.mesh)
  }
}

/** A board as a rig part: its hinge at the chains' top, white vertex colour (the map paints it). */
function tagBoard(g: BufferGeometry, part: number, s: Shingle): BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g
  const n = out.getAttribute('position').count
  const fill = (k: number, v: readonly number[]) => {
    const a = new Float32Array(n * k)
    for (let i = 0; i < n; i++) {
      a.set(v, i * k)
    }
    return new BufferAttribute(a, k)
  }
  out.setAttribute('color', fill(3, [1, 1, 1]))
  out.setAttribute('rigA', fill(4, [s.x, AWNING, s.z, part]))
  out.setAttribute('rigAxisA', fill(3, [1, 0, 0]))
  out.setAttribute('rigB', fill(4, [0, 0, 0, -1]))
  out.setAttribute('rigAxisB', fill(4, [1, 0, 0, 0]))
  out.setAttribute('rigAnim', fill(4, [0, 0, 0, 0]))
  out.setAttribute('rigCoat', fill(3, [1, 1, 1]))
  return out
}

/** Merge the chains (no UVs: given a white texel) with the boards. */
function mergeWithUv(gs: BufferGeometry[]): BufferGeometry {
  const names = [
    'position',
    'normal',
    'color',
    'rigA',
    'rigAxisA',
    'rigB',
    'rigAxisB',
    'rigAnim',
    'rigCoat',
    'uv',
  ]
  const total = gs.reduce((a, g) => a + g.getAttribute('position').count, 0)
  const out = new BufferGeometry()
  for (const name of names) {
    const size = name === 'uv' ? 2 : (gs[1]?.getAttribute(name)?.itemSize ?? 3)
    const arr = new Float32Array(total * size)
    let o = 0
    for (const g of gs) {
      const a = g.getAttribute(name)
      const count = g.getAttribute('position').count
      if (a) {
        for (let i = 0; i < count; i++) {
          for (let k = 0; k < size; k++) {
            arr[(o + i) * size + k] = a.getComponent(i, k)
          }
        }
      } else if (name === 'uv') {
        // the chains: a dark corner of the first board's border
        for (let i = 0; i < count; i++) {
          arr[(o + i) * 2] = 0.01
          arr[(o + i) * 2 + 1] = 0.99
        }
      }
      o += count
    }
    out.setAttribute(name, new BufferAttribute(arr, size))
  }
  out.computeBoundingSphere()
  return out
}

// ---------------------------------------------------------------------------------- dust devil

const DEVIL_VERT = /* glsl */ `
attribute float seed;
uniform float time;
uniform float life;
uniform float pixelRatio;
uniform vec3 base;
varying float vA;
void main() {
  float h = seed;
  float ang = time * (5.0 + h * 3.0) + seed * 97.0;
  float r = 0.15 + h * h * 1.6;
  float y = h * 6.0 + sin(time * 2.0 + seed * 31.0) * 0.2;
  vec3 p = base + vec3(cos(ang) * r, y, sin(ang) * r);
  p.x += sin(y * 0.6 + time) * 0.4 * h;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float fade = smoothstep(0.0, 0.2, life) * smoothstep(1.0, 0.75, life);
  vA = fade * (1.0 - h * 0.7) * (0.5 + 0.5 * fract(seed * 13.7));
  gl_PointSize = (0.25 + h * 0.6) * pixelRatio * 300.0 / max(-mv.z, 0.5);
}
`
const DEVIL_FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec3 color;
varying float vA;
void main() {
  float a = texture2D(map, gl_PointCoord).a * vA * 0.32;
  if (a < 0.004) discard;
  gl_FragColor = vec4(color, a);
}
`

/** A dust devil that spins up, drifts across the far street and dies away. */
export class DustDevil {
  readonly points: Points
  private readonly u = {
    time: { value: 0 },
    life: { value: 1 },
    pixelRatio: { value: 1 },
    base: { value: new Vector3() },
    map: { value: null as Texture | null },
    color: { value: new Color(0xd8_b8_8a) },
  }
  private age = 99
  private dur = 8
  private readonly from = new Vector3()
  private readonly to = new Vector3()
  private wait = 6

  constructor(root: Group, dot: Texture) {
    const n = 260
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3))
    const seed = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      seed[i] = Math.random()
    }
    g.setAttribute('seed', new BufferAttribute(seed, 1))
    this.u.map.value = dot
    const mat = new ShaderMaterial({
      vertexShader: DEVIL_VERT,
      fragmentShader: DEVIL_FRAG,
      uniforms: this.u,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    })
    this.points = new Points(g, mat)
    this.points.name = 'dust-devil'
    this.points.frustumCulled = false
    this.points.visible = false
    root.add(this.points)
  }

  /** Tint it to the light (the street dust colour). */
  setColor(c: Color): void {
    this.u.color.value.copy(c)
  }

  update(dt: number, pixelRatio: number, allowed: boolean): void {
    this.u.time.value = RIG_TIME.value
    this.u.pixelRatio.value = pixelRatio
    if (this.age >= this.dur) {
      this.points.visible = false
      this.wait -= dt
      if (this.wait <= 0 && allowed) {
        // out past the far end of the street, or out on the flats either side
        const side = Math.random() < 0.5 ? -1 : 1
        const far = Math.random() < 0.5
        this.from.set(
          far ? side * 6 : side * 24,
          0,
          far ? 46 + Math.random() * 10 : 5 + Math.random() * 30,
        )
        this.to
          .copy(this.from)
          .add(new Vector3(-side * (6 + Math.random() * 6), 0, (Math.random() - 0.5) * 8))
        this.age = 0
        this.dur = 7 + Math.random() * 4
        this.wait = 14 + Math.random() * 16
      }
      return
    }
    this.age += dt
    this.points.visible = true
    const k = this.age / this.dur
    this.u.life.value = k
    this.u.base.value.lerpVectors(this.from, this.to, k)
  }
}

// --------------------------------------------------------------------------------- screen door

/** anim: y the swing (rad, CPU-driven); a breath of wind on top. */
const DOOR_GLSL = /* glsl */ `
float partAngle(float part, float t, vec4 anim) {
  return anim.y + 0.035 * sin(t * 1.1 + anim.x) * (1.0 - min(1.0, abs(anim.y) * 4.0));
}
`

const DOOR_W = 0.9
const DOOR_H = 2.0

function screenDoorGeometry(): BufferGeometry {
  const b = new PartBuilder()
  const hinge = { part: 0, pivot: [0, 0, 0] as const, axis: [0, 1, 0] as const }
  const wood = 0x8a_6a_4a
  const board = (w: number, h: number, d: number, at: [number, number, number]) =>
    b.add(placed(new BoxGeometry(w, h, d), at), wood, hinge)
  // stiles, rails, the kick panel below and two spindles across the open top
  board(0.035, DOOR_H, 0.07, [0, DOOR_H / 2, 0.035])
  board(0.035, DOOR_H, 0.07, [0, DOOR_H / 2, DOOR_W - 0.035])
  for (const y of [0.05, 0.95, DOOR_H - 0.05]) {
    board(0.035, 0.09, DOOR_W, [0, y, DOOR_W / 2])
  }
  board(0.02, 0.85, DOOR_W - 0.1, [0.005, 0.5, DOOR_W / 2])
  for (const z of [DOOR_W / 3, (DOOR_W * 2) / 3]) {
    board(0.025, DOOR_H - 1.0, 0.025, [0, 1.48, z])
  }
  // a handle
  b.add(placed(new BoxGeometry(0.05, 0.03, 0.03), [-0.03, 1.0, DOOR_W - 0.12]), 0x2a_26_22, hinge)
  return b.build()
}

/**
 * The barber's screen door, up the right side in the standoff's frame: it stirs in the wind, and
 * at the door fake-out it bangs open and slaps shut on its frame, twice.
 */
export class ScreenDoor {
  readonly herd: RigHerd
  /** Where its hinge stands (for the sound and the dust). */
  readonly at = new Vector3(11.0, 0.34, 27 - DOOR_W / 2)
  private t = -1

  constructor(root: Group) {
    this.herd = new RigHerd(
      screenDoorGeometry(),
      rigMaterial('door', DOOR_GLSL, [3, 60, 3], 0.85),
      1,
    )
    this.herd.mesh.name = 'screen-door'
    this.hang(null)
    root.add(this.herd.mesh)
  }

  /**
   * Hang it in another arena's doorway: hinge foot at (x, y, z), turned `yaw` about it (0: the
   * street's, on a +x front opening toward -x); null puts it back on the barber's.
   */
  hang(p: { x: number; y: number; z: number; yaw: number } | null): void {
    const at = p ?? { x: 11.0, y: 0.34, z: 27 - DOOR_W / 2, yaw: 0 }
    this.at.set(at.x, at.y, at.z)
    this.herd.setMatrix(
      0,
      new Matrix4().makeRotationY(at.yaw).setPosition(this.at.x, this.at.y, this.at.z),
    )
  }

  bang(): void {
    this.t = 0
  }

  update(dt: number): void {
    if (this.t < 0) {
      return
    }
    this.t += dt
    const t = this.t
    // flung open in a fifth of a second, a beat at the top, then slapping back on its frame
    let a = 1.45
    if (t < 0.16) {
      a = Math.sin((t / 0.16) * (Math.PI / 2)) * 1.45
    } else if (t >= 0.32) {
      const u = t - 0.32
      a = 1.45 * Math.exp(-2.4 * u) * Math.abs(Math.cos(u * 5.2))
    }
    if (t > 2.4) {
      a = 0
      this.t = -1
    }
    // it opens toward the street (-x)
    this.herd.setAnim(0, -a, 0, 0)
  }
}
