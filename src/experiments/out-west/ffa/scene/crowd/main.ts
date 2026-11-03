// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: throwaway M1 spike; stream G replaces it with the real Frontier scene
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: throwaway M1 spike (one measured frame loop)
/**
 * Frontier crowd spike (design doc §13.1, the M1 "A15 crowd baseline").
 *
 * 32 outlaws with the current art, top-down:
 * - the nearest `near` (16) are GPU-skinned Actors. The own player is LOD0;
 *   the others swap to a ~3k-tri LOD1 (scene/lod.ts, meshopt in a worker).
 *   They animate at 30 Hz within 12 m and 15 Hz beyond, and only the nearest
 *   `shadows` (6) cast real shadows; everyone else gets a blob.
 * - everyone else is a VAT instance of their BASE BODY (≤7 VATs, LOD2 ~1.5k
 *   tris, baked on demand in a worker) with per-instance palette tints, plus
 *   one instanced hat mesh per hat type riding the baked head track.
 *
 * Query params: `n` (32), `near` (16), `shadows` (6), `looks` (outlaws used,
 * 17), `pack` (1 = everyone in view), `dist` (camera distance, 26), `lod1`
 * (0 disables LOD1), and `#tier=` / `#perf`. `globalThis.__crowd()` returns
 * the numbers.
 *
 * SPIKE (stream H): stream G absorbs or deletes this when it owns ffa/scene/.
 */
import {
  type BufferGeometry,
  CanvasTexture,
  Color,
  InstancedMesh,
  MathUtils,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  type SkinnedMesh,
  Vector3,
} from 'three'
import { type BodyKey, type HatKey, OUTLAWS, type Outlaw } from '../../../data/outlaws.ts'
import { loadAssets } from '../../../engine/assets.ts'
import { Renderer } from '../../../engine/render.ts'
import type { Actor, Clip } from '../../../scene/actor.ts'
import { castActor } from '../../../scene/cast.ts'
import { dressStreet } from '../../../scene/dressing.ts'
import { lodGeometry } from '../../../scene/lod.ts'
import { World } from '../../../scene/world.ts'
import { Window } from '../../../ui/perf.ts'
import { baseVat, headAt, VAT_TIME, type VatBake, VatCrowd, VatHats, vatFrame } from './vat.ts'

const params = new URLSearchParams(location.search)
const num = (k: string, d: number) => {
  const v = Number(params.get(k))
  return Number.isFinite(v) && params.has(k) ? v : d
}
const N = num('n', 32)
const NEAR = num('near', 16)
const SHADOWS = num('shadows', 6)
const LOOKS = MathUtils.clamp(num('looks', OUTLAWS.length), 1, OUTLAWS.length)
const PACK = params.get('pack') === '1'
const DIST = num('dist', 26)
const USE_LOD1 = params.get('lod1') !== '0'
const PITCH = MathUtils.degToRad(58)
const NEAR_FAST_M = 12
const CLIPS: Clip[] = ['Run', 'Gun_Shoot']

const PALETTES: [number, number][] = [
  [0x8a_3a_22, 0x3a_3a_48],
  [0x2e_4a_3a, 0x5a_44_30],
  [0xd8_c8_a0, 0x2a_2a_30],
  [0x4a_5a_7a, 0x6a_5a_44],
  [0x6a_1f_14, 0x24_20_1c],
  [0xb8_8a_44, 0x3a_30_28],
]

interface Agent {
  outlaw: Outlaw
  base: BodyKey
  hat: HatKey
  hatColor: Color
  top: Color
  bottom: Color
  pos: Vector3
  goal: Vector3
  heading: number
  speed: number
  shootT: number
  actor: Actor
  full: BufferGeometry | null
  lod1: BufferGeometry | null
  acc: number
  near: boolean
  phase: number
}

function blobTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(0,0,0,0.55)')
    g.addColorStop(0.6, 'rgba(0,0,0,0.25)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  }
  return new CanvasTexture(c)
}

function randomGoal(out: Vector3): Vector3 {
  const zr = PACK ? 10 : 34
  return out.set(MathUtils.randFloat(-7.5, 7.5), 0, MathUtils.randFloat(-zr, zr))
}

function setShadow(a: Actor, on: boolean): void {
  a.root.traverse((o) => {
    o.castShadow = on
  })
}

export async function bootCrowd(canvas: HTMLCanvasElement, status: HTMLElement): Promise<void> {
  const scene = new Scene()
  const cam = new PerspectiveCamera(30, innerWidth / innerHeight, 1, 400)
  const hint = matchMedia('(pointer: coarse)').matches ? 'low' : 'high'
  const renderer = new Renderer(canvas, scene, cam, hint, 'ffa')
  const outlaws = OUTLAWS.slice(0, LOOKS)
  const first = outlaws[0]
  if (!first) {
    return
  }
  status.textContent = 'loading…'
  const assets = await loadAssets(
    Math.min(8, renderer.gl.capabilities.getMaxAnisotropy()),
    first.look,
    (f) => {
      status.textContent = `loading ${Math.round(f * 100)}%`
    },
  )
  await Promise.all(outlaws.map((o) => assets.lookReady(o.look)))
  const world = new World(scene, assets.tex, renderer.spec.shadowSize)
  dressStreet(assets.props, world.root)
  world.apply(0.3)
  // FFA shadow: one map covering ~12 m around the camera target (§9.3)
  const sc = world.sun.shadow.camera
  sc.left = -14
  sc.right = 14
  sc.top = 14
  sc.bottom = -14
  sc.updateProjectionMatrix()

  // --- agents and their near (skinned) actors
  status.textContent = 'casting…'
  const agents: Agent[] = []
  for (let i = 0; i < N; i++) {
    const o = outlaws[i % outlaws.length] ?? first
    const pal = PALETTES[i % PALETTES.length] ?? [0x80_80_80, 0x40_40_40]
    const actor = castActor(assets, {
      look: o.look,
      hat: o.hat,
      hatColor: o.hatColor,
      bandana: o.bandana,
    })
    scene.add(actor.root)
    actor.play('Run', 0)
    agents.push({
      outlaw: o,
      base: o.look.base,
      hat: o.hat,
      hatColor: new Color(o.hatColor),
      top: new Color(pal[0]),
      bottom: new Color(pal[1]),
      pos: randomGoal(new Vector3()),
      goal: randomGoal(new Vector3()),
      heading: 0,
      speed: MathUtils.randFloat(3.5, 5.5),
      shootT: 0,
      actor,
      full: actor.meshes[0]?.geometry ?? null,
      lod1: null,
      acc: Math.random() / 30,
      near: false,
      phase: Math.random() * 3,
    })
  }

  // --- LOD1 per look (worker), VAT per base (worker), in parallel
  status.textContent = 'baking LOD1 + VAT…'
  const t0 = performance.now()
  const lodJobs = USE_LOD1
    ? agents.map(async (a, i) => {
        const g = a.full
        if (!g || i === 0) {
          return
        }
        a.lod1 = await lodGeometry(g, `${a.outlaw.name}:lod1`, 3000)
      })
    : []
  const bases = [...new Set(agents.map((a) => a.base))]
  const bakes = await Promise.all(bases.map((b) => baseVat(assets, b, CLIPS)))
  await Promise.all(lodJobs)
  const prepMs = performance.now() - t0
  const crowds = new Map<BodyKey, VatCrowd>()
  for (const b of bakes) {
    const c = new VatCrowd(b, N)
    crowds.set(b.base, c)
    scene.add(c.mesh)
  }
  const hats = new VatHats(scene, N)
  const blobs = new InstancedMesh(
    new PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }),
    N,
  )
  blobs.frustumCulled = false
  blobs.renderOrder = 1
  scene.add(blobs)
  status.textContent = ''

  try {
    await renderer.gl.compileAsync(scene, cam)
  } catch {
    // older browsers: the first frame compiles
  }
  renderer.probe.captureNow()

  const animMs = new Window(240)
  const simMs = new Window(240)
  const m4 = new Matrix4()
  const hatM = new Matrix4()
  const headM = new Matrix4()
  const one = new Vector3(1, 1, 1)
  const q = new Quaternion()
  const hq = new Quaternion()
  const hp = new Vector3()
  const up = new Vector3(0, 1, 0)
  const target = new Vector3()
  const order: Agent[] = []
  const hatLocal = new Map<BodyKey, Matrix4>(
    bakes.map((b: VatBake) => [b.base, new Matrix4().fromArray(b.hatLocal)]),
  )
  let last = performance.now()
  let nearCount = 0
  let lod1Tris = 0

  Reflect.set(globalThis, '__crowd', () => ({
    n: N,
    near: nearCount,
    far: N - nearCount,
    bases: bakes.map((b) => ({
      base: b.base,
      sourceTris: b.sourceTris,
      lod2Tris: b.index.length / 3,
      verts: b.vertexCount,
      kb: Math.round(b.bytes / 1024),
      ms: Math.round(b.ms),
      cached: b.cached,
    })),
    vatMb: bakes.reduce((s, b) => s + b.bytes, 0) / 1_048_576,
    hatTypes: hats.meshes.size,
    lod1Tris,
    prepMs,
    animP50: animMs.pct(0.5),
    animP95: animMs.pct(0.95),
    simP50: simMs.pct(0.5),
    perf: (Reflect.get(globalThis, '__owPerf') as (() => unknown) | undefined)?.() ?? null,
  }))

  const loop = (now: number) => {
    requestAnimationFrame(loop)
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const s0 = performance.now()
    // --- sim: run between random goals, stop to shoot now and then
    for (const a of agents) {
      if (a.shootT > 0) {
        a.shootT -= dt
        continue
      }
      const dx = a.goal.x - a.pos.x
      const dz = a.goal.z - a.pos.z
      const d = Math.hypot(dx, dz)
      if (d < 0.5) {
        randomGoal(a.goal)
        if (Math.random() < 0.35) {
          a.shootT = 1.2
        }
        continue
      }
      a.heading = Math.atan2(dx, dz)
      a.pos.x += (dx / d) * a.speed * dt
      a.pos.z += (dz / d) * a.speed * dt
    }
    const lead = agents[0]
    if (lead) {
      target.lerp(lead.pos, Math.min(1, dt * 4))
    }
    order.length = 0
    order.push(...agents)
    // the own player (agent 0) is always the nearest
    const dist2 = (a: Agent) => (a === lead ? -1 : a.pos.distanceToSquared(target))
    order.sort((x, y) => dist2(x) - dist2(y))
    simMs.push(performance.now() - s0)

    // --- near: skinned; far: VAT + hats + blobs
    const a0 = performance.now()
    for (const c of crowds.values()) {
      c.mesh.count = 0
    }
    hats.reset()
    blobs.count = 0
    nearCount = 0
    lod1Tris = 0
    VAT_TIME.value = now / 1000
    for (const [rank, a] of order.entries()) {
      const near = rank < NEAR
      a.actor.root.visible = near
      if (near) {
        nearCount++
        a.actor.root.position.copy(a.pos)
        a.actor.root.rotation.y = a.heading
        a.actor.play(a.shootT > 0 ? 'Gun_Shoot' : 'Run', a.near ? 0.15 : 0)
        const mesh = a.actor.meshes[0] as SkinnedMesh | undefined
        const geo = rank === 0 || !a.lod1 ? a.full : a.lod1
        if (mesh && geo && mesh.geometry !== geo) {
          mesh.geometry = geo
        }
        lod1Tris += mesh ? (mesh.geometry.index?.count ?? 0) / 3 : 0
        const caster = rank < SHADOWS
        if (caster !== a.actor.root.userData.caster) {
          a.actor.root.userData.caster = caster
          setShadow(a.actor, caster)
        }
        if (!caster) {
          m4.makeTranslation(a.pos.x, 0.03, a.pos.z)
          blobs.setMatrixAt(blobs.count++, m4)
        }
        const hz = a.pos.distanceTo(target) < NEAR_FAST_M ? 30 : 15
        a.acc += dt
        if (a.acc >= 1 / hz || !a.near) {
          a.actor.update(a.acc)
          a.acc = 0
        }
        a.near = true
        continue
      }
      a.near = false
      const c = crowds.get(a.base)
      const clip = c?.clip(a.shootT > 0 ? 'Gun_Shoot' : 'Run')
      if (!(c && clip)) {
        continue
      }
      const speed = a.shootT > 0 ? 1 : a.speed / 4.5
      const i = c.mesh.count++
      c.set(i, clip, a.phase, speed, a.top, a.bottom)
      q.setFromAxisAngle(up, a.heading)
      m4.compose(a.pos, q, one)
      c.mesh.setMatrixAt(i, m4)
      // hat: instance × head(frame) × fitted hat offset
      headAt(c.bake, clip, vatFrame(clip, a.phase, speed), hp, hq)
      headM.compose(hp, hq, one)
      hatM.multiplyMatrices(m4, headM).multiply(hatLocal.get(a.base) ?? headM.identity())
      hats.push(a.hat, hatM, a.hatColor)
      m4.makeTranslation(a.pos.x, 0.03, a.pos.z)
      blobs.setMatrixAt(blobs.count++, m4)
    }
    for (const c of crowds.values()) {
      c.commit()
    }
    hats.commit()
    blobs.instanceMatrix.needsUpdate = true
    animMs.push(performance.now() - a0)

    // --- camera: 30° FOV, pitched 58° down, DIST m from the target
    cam.aspect = innerWidth / innerHeight
    cam.position.set(target.x, target.y + Math.sin(PITCH) * DIST, target.z - Math.cos(PITCH) * DIST)
    cam.lookAt(target)
    world.focusShadow(target)
    world.update(dt)
    renderer.adapt(dt * 1000, true)
    renderer.render(dt)
  }
  addEventListener('resize', () => renderer.resize())
  requestAnimationFrame(loop)
}
