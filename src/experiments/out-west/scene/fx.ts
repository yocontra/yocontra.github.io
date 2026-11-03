import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  DoubleSide,
  Euler,
  Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  NormalBlending,
  type Object3D,
  PlaneGeometry,
  Points,
  Quaternion,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  type Texture,
  TubeGeometry,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const dustVert = /* glsl */ `
uniform float time;
uniform vec3 wind;
uniform vec3 boxMin;
uniform vec3 boxSize;
uniform float size;
uniform float pixelRatio;
attribute float seed;
varying float vAlpha;
void main() {
  vec3 p = position + wind * time * (0.6 + seed * 0.8);
  p.y += sin(time * 0.7 + seed * 40.0) * 0.25;
  p = boxMin + mod(p - boxMin, boxSize);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  vAlpha = smoothstep(0.3, 2.0, d) * (1.0 - smoothstep(25.0, 60.0, d)) * (0.35 + seed * 0.65);
  gl_PointSize = size * (0.5 + seed) * pixelRatio * 60.0 / max(d, 0.5);
}
`
const dustFrag = /* glsl */ `
uniform sampler2D map;
uniform vec3 color;
uniform float opacity;
varying float vAlpha;
void main() {
  float a = texture2D(map, gl_PointCoord).a * vAlpha * opacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(color, a);
}
`

export class Dust {
  readonly points: Points
  private readonly mat: ShaderMaterial
  private readonly u = {
    time: { value: 0 },
    wind: { value: new Vector3(1.2, 0, 0.3) },
    boxMin: { value: new Vector3(-25, 0, -40) },
    boxSize: { value: new Vector3(50, 5, 80) },
    size: { value: 0.06 },
    pixelRatio: { value: 1 },
    map: { value: null as Texture | null },
    color: { value: new Color(0xf0dcc0) },
    opacity: { value: 0.6 },
  }
  private time = 0
  constructor(count: number, tex: Texture) {
    const g = new BufferGeometry()
    const pos = new Float32Array(count * 3)
    const seed = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      pos[i * 3] = -25 + Math.random() * 50
      pos[i * 3 + 1] = Math.random() * 5
      pos[i * 3 + 2] = -40 + Math.random() * 80
      seed[i] = Math.random()
    }
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('seed', new BufferAttribute(seed, 1))
    this.mat = new ShaderMaterial({
      vertexShader: dustVert,
      fragmentShader: dustFrag,
      transparent: true,
      depthWrite: false,
      uniforms: this.u,
    })
    this.u.map.value = tex
    this.points = new Points(g, this.mat)
    this.points.frustumCulled = false
  }
  set wind(v: number) {
    this.u.wind.value.set(1.2 * v, 0, 0.3 * v)
  }
  setColor(c: Color, opacity: number): void {
    this.u.color.value.copy(c)
    this.u.opacity.value = opacity
  }
  update(dt: number, pixelRatio: number): void {
    this.time += dt
    this.u.time.value = this.time
    this.u.pixelRatio.value = pixelRatio
  }
}

const puffVert = /* glsl */ `
attribute float psize;
attribute float palpha;
attribute vec3 pcolor;
uniform float pixelRatio;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vAlpha = palpha;
  vColor = pcolor;
  gl_PointSize = psize * pixelRatio * 600.0 / max(-mv.z, 0.3);
}
`
const puffFrag = /* glsl */ `
uniform sampler2D map;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float a = texture2D(map, gl_PointCoord).a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
}
`

interface Particle {
  p: Vector3
  v: Vector3
  life: number
  max: number
  size: number
  grow: number
  alpha: number
  color: Color
  drag: number
  rise: number
}

/** CPU particle pool for puffs, muzzle smoke, sparks and flames. */
export class Puffs {
  readonly points: Points
  private readonly parts: Particle[] = []
  private readonly pos: Float32Array
  private readonly size: Float32Array
  private readonly alpha: Float32Array
  private readonly col: Float32Array
  private readonly geo: BufferGeometry
  private readonly mat: ShaderMaterial
  constructor(
    private readonly cap: number,
    tex: Texture,
    additive: boolean,
  ) {
    this.geo = new BufferGeometry()
    this.pos = new Float32Array(cap * 3)
    this.size = new Float32Array(cap)
    this.alpha = new Float32Array(cap)
    this.col = new Float32Array(cap * 3)
    this.geo.setAttribute('position', new BufferAttribute(this.pos, 3))
    this.geo.setAttribute('psize', new BufferAttribute(this.size, 1))
    this.geo.setAttribute('palpha', new BufferAttribute(this.alpha, 1))
    this.geo.setAttribute('pcolor', new BufferAttribute(this.col, 3))
    this.mat = new ShaderMaterial({
      vertexShader: puffVert,
      fragmentShader: puffFrag,
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
      uniforms: { map: { value: tex }, pixelRatio: { value: 1 } },
    })
    this.points = new Points(this.geo, this.mat)
    this.points.frustumCulled = false
    this.geo.setDrawRange(0, 0)
  }

  emit(
    at: Vector3,
    n: number,
    o: {
      speed?: number
      up?: number
      size?: number
      grow?: number
      life?: number
      color?: number
      alpha?: number
      spread?: number
      dir?: Vector3
      drag?: number
      rise?: number
    } = {},
  ): void {
    const c = new Color(o.color ?? 0xcbb08a)
    for (let i = 0; i < n; i++) {
      if (this.parts.length >= this.cap) this.parts.shift()
      const s = o.spread ?? 0.3
      const v = new Vector3((Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2)
        .normalize()
        .multiplyScalar((o.speed ?? 1) * (0.3 + Math.random()))
      v.y += o.up ?? 0.5
      if (o.dir) v.addScaledVector(o.dir, 0.5 + Math.random())
      const life = (o.life ?? 1.2) * (0.6 + Math.random() * 0.8)
      this.parts.push({
        p: at
          .clone()
          .add(
            new Vector3(
              (Math.random() - 0.5) * s,
              Math.random() * s * 0.3,
              (Math.random() - 0.5) * s,
            ),
          ),
        v,
        life,
        max: life,
        size: (o.size ?? 0.15) * (0.6 + Math.random() * 0.8),
        grow: o.grow ?? 0.4,
        alpha: o.alpha ?? 0.5,
        color: c,
        drag: o.drag ?? 2,
        rise: o.rise ?? 0,
      })
    }
  }

  update(dt: number, pixelRatio: number, wind: number): void {
    const pr = this.mat.uniforms['pixelRatio']
    if (pr) pr.value = pixelRatio
    let n = 0
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const q = this.parts[i] as Particle
      q.life -= dt
      if (q.life <= 0) {
        this.parts.splice(i, 1)
        continue
      }
      q.v.multiplyScalar(Math.exp(-q.drag * dt))
      q.v.y += q.rise * dt
      q.v.x += wind * 0.4 * dt
      q.p.addScaledVector(q.v, dt)
      if (q.p.y < 0.02) {
        q.p.y = 0.02
        q.v.y = Math.abs(q.v.y) * 0.2
      }
    }
    for (const q of this.parts) {
      const t = 1 - q.life / q.max
      this.pos[n * 3] = q.p.x
      this.pos[n * 3 + 1] = q.p.y
      this.pos[n * 3 + 2] = q.p.z
      this.size[n] = q.size * (1 + t * q.grow * 4)
      this.alpha[n] = q.alpha * Math.min(1, t * 8) * (1 - t) ** 1.5
      this.col[n * 3] = q.color.r
      this.col[n * 3 + 1] = q.color.g
      this.col[n * 3 + 2] = q.color.b
      n++
    }
    this.geo.setDrawRange(0, n)
    for (const name of ['position', 'psize', 'palpha', 'pcolor']) {
      const a = this.geo.getAttribute(name) as BufferAttribute
      a.needsUpdate = true
      a.clearUpdateRanges()
      a.addUpdateRange(0, n * a.itemSize)
    }
  }
}

function flashTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
    g.addColorStop(0, 'rgba(255,255,240,1)')
    g.addColorStop(0.2, 'rgba(255,220,140,0.9)')
    g.addColorStop(0.5, 'rgba(255,140,40,0.35)')
    g.addColorStop(1, 'rgba(255,80,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 128, 128)
    // star spikes
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = 'rgba(255,240,200,0.8)'
    ctx.lineWidth = 3
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3
      ctx.beginPath()
      ctx.moveTo(64, 64)
      ctx.lineTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62)
      ctx.stroke()
    }
  }
  return new CanvasTexture(c)
}

export class Flash {
  readonly sprite: Sprite
  private t = 0
  constructor() {
    this.sprite = new Sprite(
      new SpriteMaterial({
        map: flashTexture(),
        blending: AdditiveBlending,
        depthWrite: false,
        transparent: true,
        fog: false,
      }),
    )
    this.sprite.visible = false
  }
  fire(at: Vector3, scale = 0.7): void {
    this.sprite.position.copy(at)
    this.sprite.scale.setScalar(scale)
    this.sprite.material.rotation = Math.random() * Math.PI
    this.sprite.visible = true
    this.t = 0.06
  }
  update(dt: number): number {
    if (this.t <= 0) {
      this.sprite.visible = false
      return 0
    }
    this.t -= dt
    return Math.max(0, this.t / 0.06)
  }
}

/** Tumbleweed: a ball of thin tangled twigs. */
export function tumbleweedGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = []
  const r = 0.38
  for (let i = 0; i < 26; i++) {
    const pts: Vector3[] = []
    let a = Math.random() * Math.PI * 2
    let b = Math.acos(2 * Math.random() - 1)
    for (let k = 0; k < 6; k++) {
      const rr = r * (0.75 + Math.random() * 0.3)
      pts.push(
        new Vector3(
          Math.sin(b) * Math.cos(a) * rr,
          Math.cos(b) * rr,
          Math.sin(b) * Math.sin(a) * rr,
        ),
      )
      a += (Math.random() - 0.3) * 1.2
      b += (Math.random() - 0.5) * 0.9
    }
    parts.push(new TubeGeometry(new CatmullRomCurve3(pts), 14, 0.008, 3, false))
  }
  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return merged ?? new BufferGeometry()
}

export class Tumbleweed {
  readonly mesh: Mesh
  active = false
  private x = 0
  private z = 0
  private speed = 3
  private dir = 1
  private phase = 0
  constructor(geo: BufferGeometry, mat: MeshStandardMaterial) {
    this.mesh = new Mesh(geo, mat)
    this.mesh.castShadow = true
    this.mesh.visible = false
    this.mesh.scale.setScalar(0.8 + Math.random() * 0.6)
  }
  launch(z: number, dir: 1 | -1, speed: number): void {
    this.active = true
    this.mesh.visible = true
    this.dir = dir
    this.x = -dir * 26
    this.z = z
    this.speed = speed
    this.phase = Math.random() * 6
  }
  update(dt: number, wind: number): void {
    if (!this.active) return
    const s = this.speed * (0.7 + wind * 0.5)
    this.x += this.dir * s * dt
    this.z += Math.sin(this.phase + this.x * 0.2) * dt * 0.4
    this.phase += dt
    const bounce = Math.abs(Math.sin(this.x * 0.9 + this.phase)) * 0.45
    const r = 0.38 * this.mesh.scale.x
    this.mesh.position.set(this.x, r + bounce, this.z)
    this.mesh.rotation.z -= (this.dir * s * dt) / r
    this.mesh.rotation.x += dt * 0.5
    if (Math.abs(this.x) > 28) {
      this.active = false
      this.mesh.visible = false
    }
  }
}

interface Body {
  obj: Object3D
  v: Vector3
  w: Vector3
  rest: number
  ground: number
  flutter: number
  sleep: boolean
}

/** Minimal rigid-body toss for hats, guns and playing cards. */
export class Physics {
  private readonly bodies: Body[] = []
  private readonly q = new Quaternion()
  private readonly e = new Euler()
  add(
    obj: Object3D,
    v: Vector3,
    w: Vector3,
    o: { rest?: number; ground?: number; flutter?: number } = {},
  ): void {
    this.bodies.push({
      obj,
      v,
      w,
      rest: o.rest ?? 0.25,
      ground: o.ground ?? 0.02,
      flutter: o.flutter ?? 0,
      sleep: false,
    })
  }
  clear(): void {
    for (const b of this.bodies) b.obj.removeFromParent()
    this.bodies.length = 0
  }
  update(dt: number, wind: number): void {
    for (const b of this.bodies) {
      if (b.sleep) continue
      b.v.y -= 9.8 * dt * (b.flutter > 0 ? 0.25 : 1)
      if (b.flutter > 0) {
        b.v.x += (wind * 2.5 - b.v.x) * dt * 1.5
        b.v.y += Math.sin(performance.now() * 0.01 + b.obj.id) * b.flutter * dt
      }
      b.obj.position.addScaledVector(b.v, dt)
      this.e.set(b.w.x * dt, b.w.y * dt, b.w.z * dt)
      this.q.setFromEuler(this.e)
      b.obj.quaternion.premultiply(this.q)
      if (b.obj.position.y < b.ground) {
        b.obj.position.y = b.ground
        if (Math.abs(b.v.y) < 0.6 && b.flutter === 0) {
          b.v.set(0, 0, 0)
          b.w.multiplyScalar(0)
          // settle flat
          const up = new Vector3(0, 1, 0).applyQuaternion(b.obj.quaternion)
          if (up.y < 0) b.obj.rotateX(Math.PI)
          b.obj.rotation.x = 0
          b.obj.rotation.z = 0
          b.sleep = true
        } else {
          b.v.y = -b.v.y * b.rest
          b.v.x *= 0.6
          b.v.z *= 0.6
          b.w.multiplyScalar(0.5)
          if (b.flutter > 0 && Math.abs(b.v.y) < 0.3) b.v.y = 0
        }
      }
    }
  }
}

export function makeCard(): Mesh {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 90
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#f4efe2'
    ctx.fillRect(0, 0, 64, 90)
    ctx.fillStyle = Math.random() < 0.5 ? '#111' : '#a01010'
    ctx.font = 'bold 30px Georgia'
    ctx.fillText(Math.random() < 0.5 ? 'A' : '8', 8, 36)
    ctx.font = 'bold 40px Georgia'
    ctx.fillText(Math.random() < 0.5 ? '♠' : '♣', 18, 80)
  }
  const tex = new CanvasTexture(c)
  return new Mesh(
    new PlaneGeometry(0.063, 0.088),
    new MeshBasicMaterial({ map: tex, side: DoubleSide }),
  )
}

export class Glint {
  readonly sprite: Sprite
  private t = 0
  constructor(tex: Texture) {
    this.sprite = new Sprite(
      new SpriteMaterial({
        map: tex,
        color: 0xfff6d0,
        blending: AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    )
    this.sprite.visible = false
  }
  fire(at: Vector3): void {
    this.sprite.position.copy(at)
    this.t = 0.18
    this.sprite.visible = true
  }
  update(dt: number): void {
    if (this.t <= 0) {
      this.sprite.visible = false
      return
    }
    this.t -= dt
    const k = Math.sin((1 - this.t / 0.18) * Math.PI)
    this.sprite.scale.setScalar(0.2 + k * 1.4)
  }
}
