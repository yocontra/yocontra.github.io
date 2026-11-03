/**
 * Worker side of the base-body VAT bake: rebuild the dressed-down base actor
 * from JSON, simplify it to an LOD2 (~1.5k tris, meshopt), then sample every
 * kept vertex for every clip frame. Returns half-float positions, RGBA8
 * normals, per-vertex colour and palette slot, and the head bone's track
 * (for hats). Nothing here touches the DOM.
 */
import {
  AnimationClip,
  AnimationMixer,
  type Bone,
  DataUtils,
  Matrix4,
  type Object3D,
  ObjectLoader,
  Quaternion,
  type SkinnedMesh,
  Vector3,
} from 'three'
import { simplifyIndex } from '../../../scene/lod.ts'
import { VAT_W, type VatClipInfo, type VatJob, type VatResult } from './vat-shared.ts'

function nearestMarker(
  r: number,
  g: number,
  b: number,
  markers: [number, number, number][],
): number {
  let best = 0
  let bestD = 0.12
  for (const [i, m] of markers.entries()) {
    const d = (r - m[0]) ** 2 + (g - m[1]) ** 2 + (b - m[2]) ** 2
    if (d < bestD) {
      bestD = d
      best = i + 1
    }
  }
  return best
}

function findBody(root: Object3D): SkinnedMesh | null {
  let body: SkinnedMesh | null = null
  root.traverse((o) => {
    const s = o as SkinnedMesh
    if (
      (o as { isSkinnedMesh?: boolean }).isSkinnedMesh &&
      (!body ||
        s.geometry.getAttribute('position').count > body.geometry.getAttribute('position').count)
    ) {
      body = s
    }
  })
  return body
}

/** Simplify, compact, and return the kept source-vertex ids plus the new index. */
async function lod2(
  body: SkinnedMesh,
  targetTris: number,
): Promise<{ keep: Uint32Array; index: Uint32Array; sourceTris: number }> {
  const geo = body.geometry
  const pos = geo.getAttribute('position')
  const col = geo.getAttribute('color')
  const positions = new Float32Array(pos.count * 3)
  const colors = new Float32Array(col ? pos.count * 3 : 0)
  for (let i = 0; i < pos.count; i++) {
    positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3)
    if (col) {
      colors.set([col.getX(i), col.getY(i), col.getZ(i)], i * 3)
    }
  }
  const srcIndex = new Uint32Array(geo.index ? geo.index.count : pos.count)
  for (let i = 0; i < srcIndex.length; i++) {
    srcIndex[i] = geo.index ? geo.index.getX(i) : i
  }
  const { index } = await simplifyIndex({
    index: srcIndex,
    positions,
    colors,
    targetTris,
    maxError: 0.25,
    permissive: true,
  })
  const remap = new Int32Array(pos.count).fill(-1)
  const keep: number[] = []
  const out = new Uint32Array(index.length)
  for (const [k, v] of index.entries()) {
    let r = remap[v] ?? -1
    if (r < 0) {
      r = keep.length
      remap[v] = r
      keep.push(v)
    }
    out[k] = r
  }
  return { keep: Uint32Array.from(keep), index: out, sourceTris: srcIndex.length / 3 }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one linear bake (sample, normals, pack) kept together for speed
async function bake(job: VatJob): Promise<VatResult> {
  const root = new ObjectLoader().parse(job.json as Parameters<ObjectLoader['parse']>[0])
  root.updateMatrixWorld(true)
  const body = findBody(root)
  if (!body) {
    throw new Error('no skinned body')
  }
  let head: Bone | null = null
  root.traverse((o) => {
    if (o.uuid === job.headUuid) {
      head = o as Bone
    }
  })
  const { keep, index, sourceTris } = await lod2(body, job.targetTris)
  const nv = keep.length
  const rows = Math.ceil(nv / VAT_W)
  const geo = body.geometry
  const col = geo.getAttribute('color')
  const color = new Float32Array(nv * 3)
  const slot = new Float32Array(nv)
  for (const [i, v] of keep.entries()) {
    const r = col ? col.getX(v) : 1
    const g = col ? col.getY(v) : 1
    const b = col ? col.getZ(v) : 1
    color.set([r, g, b], i * 3)
    slot[i] = nearestMarker(r, g, b, job.markers)
  }

  const mixer = new AnimationMixer(root)
  const clips = job.clips.map((j) => AnimationClip.parse(j))
  const infos: VatClipInfo[] = []
  let total = 0
  for (const c of clips) {
    const frames = Math.max(2, Math.round(c.duration * job.fps))
    infos.push({ name: c.name.split('|').pop() ?? c.name, start: total, frames })
    total += frames
  }
  const pos = new Uint16Array(VAT_W * rows * total * 4)
  const nrm = new Uint8Array(VAT_W * rows * total * 4)
  const headTrack = new Float32Array(total * 7)
  const srcPos = geo.getAttribute('position')
  const p = new Float32Array(nv * 3)
  const n = new Float32Array(nv * 3)
  const tmp = new Vector3()
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const hp = new Vector3()
  const hq = new Quaternion()
  const hs = new Vector3()
  const m = new Matrix4()
  const toHalf = DataUtils.toHalfFloat
  for (const [ci, clip] of clips.entries()) {
    const info = infos[ci]
    if (!info) {
      continue
    }
    mixer.stopAllAction()
    const action = mixer.clipAction(clip)
    action.reset().play()
    for (let f = 0; f < info.frames; f++) {
      action.time = (f / info.frames) * clip.duration
      mixer.update(0)
      root.updateMatrixWorld(true)
      for (const [i, v] of keep.entries()) {
        tmp.fromBufferAttribute(srcPos, v)
        body.applyBoneTransform(v, tmp)
        tmp.applyMatrix4(body.matrixWorld)
        p.set([tmp.x, tmp.y, tmp.z], i * 3)
      }
      n.fill(0)
      for (let k = 0; k < index.length; k += 3) {
        const i0 = index[k] ?? 0
        const i1 = index[k + 1] ?? 0
        const i2 = index[k + 2] ?? 0
        a.fromArray(p, i0 * 3)
        b.fromArray(p, i1 * 3)
        c.fromArray(p, i2 * 3)
        c.sub(b)
        a.sub(b)
        c.cross(a)
        for (const i of [i0, i1, i2]) {
          n[i * 3] = (n[i * 3] ?? 0) + c.x
          n[i * 3 + 1] = (n[i * 3 + 1] ?? 0) + c.y
          n[i * 3 + 2] = (n[i * 3 + 2] ?? 0) + c.z
        }
      }
      const base = (info.start + f) * rows * VAT_W
      for (let i = 0; i < nv; i++) {
        const t = (base + i) * 4
        pos[t] = toHalf(p[i * 3] ?? 0)
        pos[t + 1] = toHalf(p[i * 3 + 1] ?? 0)
        pos[t + 2] = toHalf(p[i * 3 + 2] ?? 0)
        pos[t + 3] = toHalf(1)
        tmp.fromArray(n, i * 3).normalize()
        nrm[t] = Math.round((tmp.x * 0.5 + 0.5) * 255)
        nrm[t + 1] = Math.round((tmp.y * 0.5 + 0.5) * 255)
        nrm[t + 2] = Math.round((tmp.z * 0.5 + 0.5) * 255)
        nrm[t + 3] = 255
      }
      const h = head as Bone | null
      if (h) {
        m.copy(h.matrixWorld).decompose(hp, hq, hs)
        headTrack.set([hp.x, hp.y, hp.z, hq.x, hq.y, hq.z, hq.w], (info.start + f) * 7)
      }
    }
    action.stop()
  }
  return {
    pos,
    nrm,
    color,
    slot,
    index,
    rows,
    vertexCount: nv,
    clips: infos,
    head: headTrack,
    sourceTris,
  }
}

const scope = globalThis as unknown as Worker

scope.onmessage = async (e: MessageEvent<{ id: number; job: VatJob }>) => {
  try {
    const r = await bake(e.data.job)
    scope.postMessage({ id: e.data.id, result: r }, [
      r.pos.buffer,
      r.nrm.buffer,
      r.color.buffer,
      r.slot.buffer,
      r.index.buffer,
      r.head.buffer,
    ])
  } catch (err) {
    scope.postMessage({ id: e.data.id, error: String(err) })
  }
}
