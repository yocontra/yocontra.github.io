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
import { atlasRows, packNormal, unpackNormal } from './packing.ts'
import { paletteColor } from './palette.ts'
import { VAT_W, type VatClipInfo, type VatJob, type VatResult } from './vat-shared.ts'

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
  const uv = geo.getAttribute('uv')
  const stride = uv ? 5 : 3
  const positions = new Float32Array(pos.count * 3)
  const colors = new Float32Array(col ? pos.count * stride : 0)
  for (let i = 0; i < pos.count; i++) {
    positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3)
    if (col) {
      colors.set([col.getX(i), col.getY(i), col.getZ(i)], i * stride)
      if (uv) {
        colors.set([uv.getX(i), uv.getY(i)], i * stride + 3)
      }
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
    stride,
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
  const geo = body.geometry
  const col = geo.getAttribute('color')
  const palette = geo.getAttribute('paletteSlot')
  if (!palette) {
    throw new Error('VAT source lacks semantic palette metadata')
  }
  const uvA = geo.getAttribute('uv')
  const lumA = geo.getAttribute('styLum')
  const styleA = geo.getAttribute('styMat')
  const style = new Float32Array(nv * 2)
  const color = new Float32Array(nv * 3)
  const uv = new Float32Array(nv * 2)
  const lum = new Float32Array(nv)
  const slot = new Float32Array(nv)
  for (const [i, v] of keep.entries()) {
    uv.set([uvA ? uvA.getX(v) : 0.5, uvA ? uvA.getY(v) : 0.5], i * 2)
    lum[i] = lumA ? lumA.getX(v) : 0
    style.set([styleA ? styleA.getX(v) : 1, styleA ? styleA.getY(v) : 1], i * 2)
    const r = col ? col.getX(v) : 1
    const g = col ? col.getY(v) : 1
    const b = col ? col.getZ(v) : 1
    slot[i] = palette.getX(v)
    color.set(paletteColor(slot[i] ?? 0, [r, g, b], job.markers), i * 3)
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
  const posRows = atlasRows(nv, total, 3, VAT_W)
  const nrmRows = atlasRows(nv, total, 2, VAT_W)
  const pos = new Uint16Array(VAT_W * posRows * 4)
  const nrm = new Uint8Array(VAT_W * nrmRows * 4)
  const quantization = { positionM: 0, normalDeg: 0 }
  const decoded = new Vector3()
  const headTrack = new Float32Array(total * 7)
  const sockets: Record<string, Float32Array> = {}
  const nodes: Record<string, Object3D> = {}
  for (const [name, uuid] of Object.entries(job.sockets)) {
    const node = root.getObjectByProperty('uuid', uuid)
    if (node) {
      nodes[name] = node
      sockets[name] = new Float32Array(total * 10)
    }
  }
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
      const base = (info.start + f) * nv
      for (let i = 0; i < nv; i++) {
        const t = (base + i) * 3
        let positionSq = 0
        for (let axis = 0; axis < 3; axis++) {
          const value = p[i * 3 + axis] ?? 0
          const half = toHalf(value)
          pos[t + axis] = half
          positionSq += (DataUtils.fromHalfFloat(half) - value) ** 2
        }
        quantization.positionM = Math.max(quantization.positionM, Math.sqrt(positionSq))
        tmp.fromArray(n, i * 3)
        if (tmp.lengthSq() < 1e-12) {
          tmp.set(0, 1, 0)
        } else {
          tmp.normalize()
        }
        const norm = (base + i) * 2
        packNormal(tmp, nrm, norm)
        unpackNormal(nrm[norm] ?? 0, nrm[norm + 1] ?? 0, decoded)
        quantization.normalDeg = Math.max(
          quantization.normalDeg,
          (Math.acos(Math.min(1, Math.max(-1, tmp.dot(decoded)))) * 180) / Math.PI,
        )
      }
      for (const [name, node] of Object.entries(nodes)) {
        node.matrixWorld.decompose(hp, hq, hs)
        sockets[name]?.set(
          [hp.x, hp.y, hp.z, hq.x, hq.y, hq.z, hq.w, hs.x, hs.y, hs.z],
          (info.start + f) * 10,
        )
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
    uv,
    lum,
    slot,
    style,
    sockets,
    index,
    posRows,
    nrmRows,
    quantization,
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
      r.uv.buffer,
      r.lum.buffer,
      r.slot.buffer,
      r.style.buffer,
      ...Object.values(r.sockets).map((s) => s.buffer),
      r.index.buffer,
      r.head.buffer,
    ])
  } catch (err) {
    scope.postMessage({ id: e.data.id, error: String(err) })
  }
}
