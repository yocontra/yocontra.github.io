// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: throwaway M1 spike; stream G replaces it with the real Frontier scene
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: throwaway M1 spike (one measured frame loop)
/**
 * Frontier crowd spike (design doc §13.1, the M1 "A15 crowd baseline").
 *
 * 32 outlaws with the current art, top-down: the nearest 16 GPU-skinned
 * Actors (animated at 30 Hz within 12 m, 15 Hz beyond), everyone else drawn
 * as vertex-animation-texture instances, one instanced draw per look plus one
 * draw of blob shadows. The town is the Quick Draw street as a stand-in.
 *
 * Query params: `n` (agents, 32), `near` (skinned cap, 16), `looks` (1–7, 4),
 * `pack` (1 = everyone within view), `dist` (camera distance, 26), and the
 * usual `#tier=` / `#perf`. `globalThis.__crowd()` returns the numbers.
 *
 * SPIKE (stream H): stream G absorbs or deletes this when it owns ffa/scene/.
 */
import {
  CanvasTexture,
  InstancedMesh,
  MathUtils,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  Vector3,
} from 'three'
import { OUTLAWS } from '../../../data/outlaws.ts'
import { loadAssets } from '../../../engine/assets.ts'
import { Renderer } from '../../../engine/render.ts'
import type { Actor, Clip } from '../../../scene/actor.ts'
import { castActor } from '../../../scene/cast.ts'
import { dressStreet } from '../../../scene/dressing.ts'
import { World } from '../../../scene/world.ts'
import { Window } from '../../../ui/perf.ts'
import { bakeVat, VAT_TIME, type VatClip, VatCrowd } from './vat.ts'

const params = new URLSearchParams(location.search)
const num = (k: string, d: number) => {
  const v = Number(params.get(k))
  return Number.isFinite(v) && params.has(k) ? v : d
}
const N = num('n', 32)
const NEAR = num('near', 16)
const LOOKS = MathUtils.clamp(num('looks', 4), 1, 7)
const PACK = params.get('pack') === '1'
const DIST = num('dist', 26)
const PITCH = MathUtils.degToRad(58)
const NEAR_FAST_M = 12

/** Distinct bases first, so each look is a different silhouette. */
const LOOK_IDS = [0, 1, 2, 3, 4, 5, 7]

interface Agent {
  look: number
  pos: Vector3
  goal: Vector3
  heading: number
  speed: number
  shootT: number
  actor: Actor
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

export async function bootCrowd(canvas: HTMLCanvasElement, status: HTMLElement): Promise<void> {
  const scene = new Scene()
  const cam = new PerspectiveCamera(30, innerWidth / innerHeight, 1, 400)
  const renderer = new Renderer(
    canvas,
    scene,
    cam,
    matchMedia('(pointer: coarse)').matches ? 'low' : 'high',
    'ffa',
  )
  const looks = LOOK_IDS.slice(0, LOOKS)
    .map((i) => (OUTLAWS[i] ?? OUTLAWS[0])?.look)
    .filter((l) => l !== undefined)
  const first = looks[0]
  if (!first) {
    return
  }
  status.textContent = 'loading…'
  const assets = await loadAssets(
    Math.min(8, renderer.gl.capabilities.getMaxAnisotropy()),
    first,
    (f) => {
      status.textContent = `loading ${Math.round(f * 100)}%`
    },
  )
  await Promise.all(looks.map((l) => assets.lookReady(l)))
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

  status.textContent = 'baking VAT…'
  const clips: Clip[] = ['Run', 'Idle', 'Gun_Shoot']
  const t0 = performance.now()
  const crowds: VatCrowd[] = []
  for (const look of looks) {
    const tmpl = castActor(assets, { look, hat: 'cowboy', hatColor: 0x2a_1d_14 })
    crowds.push(new VatCrowd(bakeVat(tmpl, clips), N))
    tmpl.dispose()
  }
  const bakeMs = performance.now() - t0
  for (const c of crowds) {
    scene.add(c.mesh)
  }
  const blobs = new InstancedMesh(
    new PlaneGeometry(1.3, 1.3).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }),
    N,
  )
  blobs.frustumCulled = false
  blobs.renderOrder = 1
  scene.add(blobs)

  const agents: Agent[] = []
  for (let i = 0; i < N; i++) {
    const look = i % looks.length
    const l = looks[look] ?? first
    const actor = castActor(assets, { look: l, hat: 'cowboy', hatColor: 0x2a_1d_14 })
    actor.root.traverse((o) => {
      o.castShadow = true
    })
    scene.add(actor.root)
    actor.play('Run', 0)
    const pos = randomGoal(new Vector3())
    agents.push({
      look,
      pos,
      goal: randomGoal(new Vector3()),
      heading: 0,
      speed: MathUtils.randFloat(3.5, 5.5),
      shootT: 0,
      actor,
      acc: Math.random() / 30,
      near: false,
      phase: Math.random() * 3,
    })
  }
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
  const q = new Quaternion()
  const up = new Vector3(0, 1, 0)
  const one = new Vector3(1, 1, 1)
  const target = new Vector3()
  const order: Agent[] = []
  let last = performance.now()
  let nearCount = 0

  const clipOf = (a: Agent, c: VatCrowd): VatClip | null =>
    c.clip(a.shootT > 0 ? 'Gun_Shoot' : 'Run')

  Reflect.set(globalThis, '__crowd', () => ({
    n: N,
    near: nearCount,
    far: N - nearCount,
    looks: looks.length,
    vatVertices: crowds.map((c) => c.bake.vertexCount),
    vatMb: crowds.reduce((s, c) => s + c.bake.bytes, 0) / 1_048_576,
    vatFrames: crowds[0]?.bake.clips.map((c) => `${c.name}:${c.frames}`),
    tris: crowds.map((c) => (c.bake.geometry.index?.count ?? 0) / 3),
    bakeMs,
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
    order.sort((x, y) => x.pos.distanceToSquared(target) - y.pos.distanceToSquared(target))
    simMs.push(performance.now() - s0)

    // --- near: skinned actors at 30/15 Hz; far: VAT instances
    const a0 = performance.now()
    for (const c of crowds) {
      c.mesh.count = 0
    }
    blobs.count = 0
    nearCount = 0
    for (const [rank, a] of order.entries()) {
      const near = rank < NEAR
      a.actor.root.visible = near
      if (near) {
        nearCount++
        a.actor.root.position.copy(a.pos)
        a.actor.root.rotation.y = a.heading
        const clip: Clip = a.shootT > 0 ? 'Gun_Shoot' : 'Run'
        a.actor.play(clip, a.near ? 0.15 : 0)
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
      const c = crowds[a.look]
      if (!c) {
        continue
      }
      const clip = clipOf(a, c)
      const i = c.mesh.count++
      if (clip) {
        c.setClip(i, clip, a.phase, a.shootT > 0 ? 1 : a.speed / 4.5)
      }
      q.setFromAxisAngle(up, a.heading)
      m4.compose(a.pos, q, one)
      c.mesh.setMatrixAt(i, m4)
      m4.makeTranslation(a.pos.x, 0.03, a.pos.z)
      blobs.setMatrixAt(blobs.count++, m4)
    }
    for (const c of crowds) {
      c.mesh.instanceMatrix.needsUpdate = true
    }
    blobs.instanceMatrix.needsUpdate = true
    VAT_TIME.value = now / 1000
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
