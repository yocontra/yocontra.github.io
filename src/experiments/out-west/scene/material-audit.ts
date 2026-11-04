// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: one flat classification pass per material
// biome-ignore-all lint/style/noMagicNumbers: report thresholds, named where they matter
// biome-ignore-all lint/style/noNestedTernary: short label picks in a dev report
/**
 * Dev-only material audit. `tools/material-audit.ts` imports this into the running page from the
 * dev server (like `float-audit.ts`); the game never imports it, so it never ships.
 *
 * It walks every captured scene and records, per material: its type (and whether a shader patch
 * is installed through `onBeforeCompile`), which maps it carries and in which colour space, its
 * roughness / metalness / environment response, the shadow flags of the meshes drawing it, its
 * sidedness, and the vertex normals of its geometry (smooth, mixed or faceted; tangents). Known
 * mistakes are listed per row: a data map tagged sRGB, a colour map left linear, an AO map with no
 * second UV set, an unlit or non-PBR material on a lit mesh, no image-based light, a character
 * that doesn't receive shadows.
 */
import {
  type BufferGeometry,
  type DirectionalLight,
  DoubleSide,
  type HemisphereLight,
  type Light,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Scene,
  SRGBColorSpace,
  type Texture,
  type WebGLRenderer,
} from 'three'

export interface MatRow {
  name: string
  type: string
  /** A shader patch is installed (onBeforeCompile). */
  patched: boolean
  meshes: number
  skinned: number
  instanced: number
  tris: number
  /** First few mesh names drawing it. */
  sample: string
  map: string
  normal: string
  rough: string
  metal: string
  ao: string
  emissive: string
  roughness: number | null
  metalness: number | null
  env: string
  /** Fraction of its meshes that cast / receive shadows. */
  cast: number
  receive: number
  side: string
  flat: boolean
  vcol: boolean
  normals: string
  issues: string[]
}

export interface LightRow {
  type: string
  name: string
  intensity: number
  color: string
  shadow: string
}

export interface MaterialReport {
  rows: MatRow[]
  lights: LightRow[]
  environment: string
  toneMapping: number
}

/** Materials that are meant to be unlit or are not surfaces (sky, effects, glows, impostor cards). */
const UNLIT_OK =
  /sky|fx|flash|smoke|dust|spark|glow|muzzle|tracer|beam|ring|shadow|blob|fog|cloud|star|moon|sun|halo|flare|marker|cue|ui|decal|water|black|wind|ray|lamp|flame|fire|ember|silhouette|poster|impostor/iu

const NON_PBR = /Lambert|Phong|Toon/u

interface Acc {
  mat: Material
  meshes: Mesh[]
}

function texInfo(
  t: Texture | null | undefined,
  wantSrgb: boolean,
  issues: string[],
  k: string,
): string {
  if (!t) {
    return '-'
  }
  const srgb = t.colorSpace === SRGBColorSpace
  const img = t.image as { width?: number; height?: number } | null | undefined
  const size = img?.width ? `${img.width}` : '?'
  if (wantSrgb && !srgb) {
    issues.push(`${k} not sRGB`)
  }
  if (!wantSrgb && srgb) {
    issues.push(`${k} tagged sRGB`)
  }
  return `${srgb ? 'sRGB' : 'lin'} ${size}`
}

const normalsCache = new WeakMap<BufferGeometry, string>()

type Attr = ReturnType<BufferGeometry['getAttribute']>

/** Shared positions whose vertex normals differ by more than ~35 degrees, as a label. */
function hardEdges(p: Attr, n: Attr): string {
  const seen = new Map<string, [number, number, number]>()
  let shared = 0
  let hard = 0
  const count = Math.min(p.count, 6000)
  for (let i = 0; i < count; i++) {
    const key = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`
    const nv: [number, number, number] = [n.getX(i), n.getY(i), n.getZ(i)]
    const prev = seen.get(key)
    if (prev) {
      shared++
      if (prev[0] * nv[0] + prev[1] * nv[1] + prev[2] * nv[2] < 0.82) {
        hard++
      }
    } else {
      seen.set(key, nv)
    }
  }
  const f = shared > 0 ? hard / shared : 0
  return f > 0.6 ? 'faceted' : f > 0.15 ? 'mixed' : 'smooth'
}

/**
 * Smooth vs faceted, sampled: positions shared by vertices whose normals differ by more than
 * ~35 degrees are hard edges. Over 60 % of shared positions hard = faceted, over 15 % = mixed.
 */
function normalsOf(g: BufferGeometry): string {
  const have = normalsCache.get(g)
  if (have) {
    return have
  }
  const p = g.getAttribute('position')
  const n = g.getAttribute('normal')
  const out = p && n ? hardEdges(p, n) + (g.getAttribute('tangent') ? '+tan' : '') : 'none'
  normalsCache.set(g, out)
  return out
}

function trisOf(g: BufferGeometry): number {
  const idx = g.index
  return Math.round((idx ? idx.count : (g.getAttribute('position')?.count ?? 0)) / 3)
}

/** Walk the scenes and audit every material on a visible-or-not mesh. */
export function auditMaterials(scenes: Object3D[], renderer?: WebGLRenderer): MaterialReport {
  const accs = new Map<string, Acc>()
  const lights: LightRow[] = []
  let environment = 'none'
  for (const s of scenes) {
    const sc = s as Scene
    if (sc.isScene && sc.environment) {
      environment = `PMREM × ${sc.environmentIntensity.toFixed(2)}`
    }
    s.traverse((o) => {
      const l = o as Light
      if (l.isLight) {
        const hemi = l as HemisphereLight
        lights.push({
          type: l.type,
          name: l.name || '-',
          intensity: l.intensity,
          color: hemi.isHemisphereLight
            ? `#${hemi.color.getHexString()}/#${hemi.groundColor.getHexString()}`
            : `#${l.color.getHexString()}`,
          shadow:
            l.castShadow && (l as DirectionalLight).shadow
              ? `${(l as DirectionalLight).shadow.mapSize.x}`
              : '-',
        })
        return
      }
      const m = o as Mesh
      // biome-ignore lint/suspicious/noUnnecessaryConditions: three types isMesh as `true` on the cast; this is the runtime type check
      if (!(m.isMesh && m.material)) {
        return
      }
      const mats = Array.isArray(m.material) ? m.material : [m.material]
      for (const mat of mats) {
        const a = accs.get(mat.uuid) ?? { mat, meshes: [] }
        a.meshes.push(m)
        accs.set(mat.uuid, a)
      }
    })
  }
  const rows: MatRow[] = []
  for (const { mat, meshes } of accs.values()) {
    const std = mat as MeshStandardMaterial
    const issues: string[] = []
    const lit = 'isMeshStandardMaterial' in std && std.isMeshStandardMaterial === true
    const label = `${mat.name} ${meshes[0]?.name ?? ''}`
    const unlitOk = UNLIT_OK.test(label) || mat.type === 'ShaderMaterial'
    if (!lit && NON_PBR.test(mat.type)) {
      issues.push('non-PBR lit')
    }
    if (mat.type === 'MeshBasicMaterial' && !unlitOk && !mat.transparent) {
      issues.push('unlit on a surface')
    }
    const skinned = meshes.filter((m) => (m as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh)
    const instanced = meshes.filter(
      (m) => (m as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh,
    )
    const geo = meshes[0]?.geometry
    let ao = '-'
    let normal = '-'
    if (lit) {
      ao = texInfo(std.aoMap, false, issues, 'aoMap')
      if (
        std.aoMap &&
        geo &&
        !geo.getAttribute(std.aoMap.channel === 0 ? 'uv' : `uv${std.aoMap.channel}`)
      ) {
        issues.push(`aoMap uv${std.aoMap.channel} missing`)
      }
      normal = texInfo(std.normalMap, false, issues, 'normalMap')
      if (std.normalMap) {
        normal += ` ×${std.normalScale.x.toFixed(2)}`
      }
      const envI = std.envMapIntensity
      const hasEnv = Boolean(std.envMap) || environment !== 'none'
      if (!hasEnv) {
        issues.push('no IBL')
      } else if (envI <= 0.05) {
        issues.push('envMapIntensity ~0')
      }
      if (std.flatShading && mat.userData.faceted !== true) {
        issues.push('flatShading')
      }
    }
    const cast = meshes.filter((m) => m.castShadow).length / Math.max(1, meshes.length)
    const receive = meshes.filter((m) => m.receiveShadow).length / Math.max(1, meshes.length)
    if (skinned.length > 0 && receive < 1) {
      issues.push('skinned not receiving shadows')
    }
    if (lit && !unlitOk && receive === 0 && !mat.transparent) {
      issues.push('receives no shadows')
    }
    rows.push({
      name: mat.name || '(unnamed)',
      type: mat.type.replace('Material', '').replace('Mesh', ''),
      patched: Object.hasOwn(mat, 'onBeforeCompile'),
      meshes: meshes.length,
      skinned: skinned.length,
      instanced: instanced.length,
      tris: meshes.reduce((t, m) => t + trisOf(m.geometry), 0),
      sample: [...new Set(meshes.map((m) => m.name || m.parent?.name || '?'))]
        .slice(0, 2)
        .join(','),
      map: texInfo((std as { map?: Texture | null }).map, true, issues, 'map'),
      normal,
      rough: lit ? texInfo(std.roughnessMap, false, issues, 'roughnessMap') : '-',
      metal: lit ? texInfo(std.metalnessMap, false, issues, 'metalnessMap') : '-',
      ao,
      emissive: lit
        ? `${std.emissive.getHexString()}${std.emissiveMap ? '+map' : ''} ×${std.emissiveIntensity.toFixed(2)}`
        : '-',
      roughness: lit ? std.roughness : null,
      metalness: lit ? std.metalness : null,
      env: lit
        ? `${std.envMap ? 'own' : environment === 'none' ? 'none' : 'scene'} ×${std.envMapIntensity.toFixed(2)}`
        : '-',
      cast,
      receive,
      side: mat.side === DoubleSide ? 'double' : mat.side === 0 ? 'front' : 'back',
      flat: lit ? std.flatShading : false,
      vcol: mat.vertexColors,
      normals: geo ? normalsOf(geo) : '-',
      issues,
    })
  }
  rows.sort((a, b) => b.tris - a.tris)
  return { rows, lights, environment, toneMapping: renderer?.toneMapping ?? -1 }
}
