// biome-ignore-all lint/complexity/useMaxParams: canvas sweep takes a rect positionally
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: one canvas bake, channel by channel
/**
 * The Perdition ground: one plane, the dirt texture tiled in world metres, and a 1024² mask baked
 * once from the layout on a canvas:
 *
 * - R: baked sun visibility (building and cover shadows for the late-afternoon sun, soft), which
 *   scales only the direct light, so character shadows from the real-time map never double the
 *   ambient darkening;
 * - G: street wear (packed, darker, wheel ruts);
 * - B: wet sand by the creek and contact darkening around walls.
 */
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  Float32BufferAttribute,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Texture,
  Vector2,
  type Vector3,
} from 'three'
import { buildingWalls, type TownLayout } from '../sim/layout.ts'
import { COVER_VISUALS } from './cover-kinds.ts'

const MASK_PX = 1024

export interface GroundTex {
  map: Texture
  normal: Texture
}

function paint(
  layout: TownLayout,
  sun: Vector3,
): { r: HTMLCanvasElement; g: HTMLCanvasElement; b: HTMLCanvasElement } {
  const k = MASK_PX / layout.size
  const make = (fill: string) => {
    const c = document.createElement('canvas')
    c.width = MASK_PX
    c.height = MASK_PX
    const ctx = c.getContext('2d')
    if (ctx) {
      ctx.fillStyle = fill
      ctx.fillRect(0, 0, MASK_PX, MASK_PX)
      ctx.setTransform(k, 0, 0, k, 0, 0)
    }
    return { c, ctx }
  }
  // --- R: shadows. Sweep each footprint along the sun's ground direction.
  const r = make('#fff')
  const elev = Math.asin(Math.max(0.2, sun.y))
  const gx = -sun.x
  const gz = -sun.z
  const gl = Math.hypot(gx, gz) || 1
  const reach = 1 / Math.tan(elev)
  const sweep = (x: number, z: number, w: number, d: number, h: number, alpha: number) => {
    const ctx = r.ctx
    if (!ctx) {
      return
    }
    ctx.fillStyle = `rgba(0,0,0,${alpha})`
    const n = Math.max(2, Math.ceil(h * reach * 2))
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * h * reach
      ctx.fillRect(x + (gx / gl) * t, z + (gz / gl) * t, w, d)
    }
  }
  for (const b of layout.buildings) {
    sweep(b.x, b.z, b.w, b.d, b.height + (b.kind === 'tower' ? 0 : 0.6), 0.09)
  }
  for (const c of layout.cover) {
    // thin pieces (rails, posts, fences) cast thin, faint shadows; not a dark slab per rect
    const vis = COVER_VISUALS[c.kind]
    const thin = Math.min(c.w, c.d) <= 0.5
    sweep(c.x, c.z, c.w, c.d, vis?.height ?? (c.low ? 0.9 : 3.6), thin ? 0.04 : 0.08)
  }
  // --- G: streets, with ruts and soft edges.
  const g = make('#000')
  if (g.ctx) {
    g.ctx.fillStyle = '#fff'
    for (const s of layout.streets) {
      g.ctx.fillRect(s.x + 0.6, s.z + 0.6, s.w - 1.2, s.d - 1.2)
    }
    g.ctx.strokeStyle = 'rgba(0,0,0,0.35)'
    g.ctx.lineWidth = 0.35
    for (const s of layout.streets) {
      const horizontal = s.w > s.d
      for (const off of [-1.6, -0.2, 1.4, 2.8]) {
        g.ctx.beginPath()
        if (horizontal) {
          const z = s.z + s.d / 2 + off
          g.ctx.moveTo(s.x, z)
          for (let x = s.x; x <= s.x + s.w; x += 4) {
            g.ctx.lineTo(x, z + Math.sin(x * 0.11 + off) * 0.25)
          }
        } else {
          const x = s.x + s.w / 2 + off * 0.6
          g.ctx.moveTo(x, s.z)
          for (let z = s.z; z <= s.z + s.d; z += 4) {
            g.ctx.lineTo(x + Math.sin(z * 0.13 + off) * 0.2, z)
          }
        }
        g.ctx.stroke()
      }
    }
  }
  // --- B: wet sand by the creek, and soot at the foot of every wall.
  const b = make('#000')
  if (b.ctx) {
    const cr = layout.creek
    b.ctx.fillStyle = 'rgba(255,255,255,0.55)'
    b.ctx.fillRect(cr.x, cr.z - 0.5, cr.w, cr.d + 1.5)
    b.ctx.fillStyle = 'rgba(255,255,255,0.9)'
    b.ctx.fillRect(cr.x, cr.z + cr.d / 2 - 0.6, cr.w, 2.4)
    b.ctx.strokeStyle = 'rgba(255,255,255,0.55)'
    b.ctx.lineWidth = 0.7
    for (const bd of layout.buildings) {
      for (const w of buildingWalls(bd)) {
        b.ctx.strokeRect(w.x, w.z, w.w, w.d)
      }
    }
    // contact grime only under the big pieces (a dark ring round every crate and rail read as a
    // dirt patch at eye level)
    b.ctx.lineWidth = 0.3
    b.ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    for (const c of layout.cover) {
      if (c.w * c.d >= 4) {
        b.ctx.strokeRect(c.x, c.z, c.w, c.d)
      }
    }
  }
  return { r: r.c, g: g.c, b: b.c }
}

function blurred(src: HTMLCanvasElement, px: number): Uint8ClampedArray {
  const c = document.createElement('canvas')
  c.width = MASK_PX
  c.height = MASK_PX
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    return new Uint8ClampedArray(MASK_PX * MASK_PX * 4)
  }
  ctx.filter = `blur(${px}px)`
  ctx.drawImage(src, 0, 0)
  return ctx.getImageData(0, 0, MASK_PX, MASK_PX).data
}

export function bakeGroundMask(layout: TownLayout, sun: Vector3): CanvasTexture {
  const { r, g, b } = paint(layout, sun)
  const dr = blurred(r, 3)
  const dg = blurred(g, 4)
  const db = blurred(b, 3)
  const out = document.createElement('canvas')
  out.width = MASK_PX
  out.height = MASK_PX
  const ctx = out.getContext('2d')
  if (ctx) {
    const img = ctx.createImageData(MASK_PX, MASK_PX)
    for (let i = 0; i < img.data.length; i += 4) {
      // Shadows never go fully black: the sky still fills them a little.
      img.data[i] = Math.max(40, dr[i] ?? 255)
      img.data[i + 1] = dg[i] ?? 0
      img.data[i + 2] = db[i] ?? 0
      img.data[i + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
  }
  const t = new CanvasTexture(out)
  t.wrapS = ClampToEdgeWrapping
  t.wrapT = ClampToEdgeWrapping
  t.minFilter = LinearFilter
  t.generateMipmaps = false
  t.flipY = false
  return t
}

/** GLSL: the strongest of the trails leaving town where a street runs out near the map's edge. */
function trailCalls(layout: TownLayout): string {
  const s = layout.size
  const f = (v: number) => v.toFixed(2)
  const calls: string[] = []
  for (const st of layout.streets) {
    const ends: [number, number, number, number, number][] = []
    if (st.x < 8) {
      ends.push([st.x, st.z + st.d / 2, -1, 0, st.d / 2])
    }
    if (st.x + st.w > s - 8) {
      ends.push([st.x + st.w, st.z + st.d / 2, 1, 0, st.d / 2])
    }
    if (st.z + st.d > s - 8) {
      ends.push([st.x + st.w / 2, st.z + st.d, 0, 1, st.w / 2])
    }
    if (st.z <= layout.creek.z + layout.creek.d + 1) {
      ends.push([st.x + st.w / 2, st.z, 0, -1, st.w / 2])
    }
    for (const [x, z, dx, dz, w] of ends) {
      calls.push(`gTrail(vGW, vec2(${f(x)}, ${f(z)}), vec2(${f(dx)}, ${f(dz)}), ${f(w)})`)
    }
  }
  return calls.reduce((a, c) => `max(${a}, ${c})`, '0.0')
}

/** The ground plane over the town and far beyond it (the portrait camera sees a long way). */
export function groundMesh(layout: TownLayout, tex: GroundTex, mask: Texture): Mesh {
  const extent = 520
  const geo = new PlaneGeometry(extent, extent, 1, 1).rotateX(-Math.PI / 2)
  geo.translate(layout.size / 2, 0, layout.size / 2)
  const uv = geo.getAttribute('uv')
  const pos = geo.getAttribute('position')
  const tile = 5
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, pos.getX(i) / tile, -pos.getZ(i) / tile)
  }
  // white: the outskirts terrain shares this material and tints its cliffs and scrub by vertex
  geo.setAttribute('color', new Float32BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3))
  const map = tex.map.clone()
  const normal = tex.normal.clone()
  map.needsUpdate = true
  normal.needsUpdate = true
  const mat = new MeshStandardMaterial({
    map,
    normalMap: normal,
    normalScale: new Vector2(0.8, 0.8),
    roughness: 0.96,
    metalness: 0,
    color: 0xd2_ce_c8,
    vertexColors: true,
  })
  const size = layout.size
  const trails = trailCalls(layout)
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.gMask = { value: mask }
    shader.uniforms.gSize = { value: size }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec2 vGW;\nvarying vec3 vGP;\nvarying vec3 vGN;',
      )
      .replace(
        '#include <worldpos_vertex>',
        // the outskirts' cliffs slide their pattern by height, so it isn't smeared down a face
        '#include <worldpos_vertex>\nvec4 gW4 = modelMatrix * vec4(transformed, 1.0);\nvGW = gW4.xz - gW4.y * objectNormal.xz;\nvGP = gW4.xyz;\nvGN = normalize(mat3(modelMatrix) * objectNormal);',
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D gMask;
uniform float gSize;
varying vec2 vGW;
varying vec3 vGP;
varying vec3 vGN;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// a wagon trail running on out of town from a street's end, wandering and narrowing
float gTrail(vec2 p, vec2 o, vec2 dir, float w0) {
  vec2 d = p - o;
  float t = dot(d, dir);
  float off = dot(d, vec2(-dir.y, dir.x)) - sin(t * 0.085) * 1.8 * smoothstep(0.0, 24.0, t);
  float w = mix(w0, 2.4, smoothstep(0.0, 28.0, t));
  return step(-1.0, t) * (1.0 - smoothstep(w * 0.6, w, abs(off))) * (1.0 - smoothstep(45.0, 80.0, t));
}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
vec2 gUv = vGW / gSize;
vec4 gM = texture2D(gMask, gUv);
float gOut = (gUv.x < 0.0 || gUv.x > 1.0 || gUv.y < 0.0 || gUv.y > 1.0) ? 1.0 : 0.0;
gM = mix(gM, vec4(1.0, 0.0, 0.0, 1.0), gOut);
gM.g = max(gM.g, ${trails});`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  // the outskirts' cliffs: blend in side projections so the dirt isn't smeared down a face (the
  // flat ground never takes this branch)
  vec3 gN = normalize(vGN);
  if (gN.y < 0.9) {
    vec3 gWt = pow(abs(gN), vec3(4.0));
    gWt /= gWt.x + gWt.y + gWt.z;
    vec4 gSx = texture2D(map, vec2(vGP.z, -vGP.y) * 0.2);
    vec4 gSz = texture2D(map, vec2(vGP.x, -vGP.y) * 0.2);
    vec4 gTri = sampledDiffuseColor * gWt.y + gSx * gWt.x + gSz * gWt.z;
    diffuseColor.rgb = diffuse * gTri.rgb;
  }
}
{
  float n = gNoise(vGW * 0.35) * 0.6 + gNoise(vGW * 1.7) * 0.4;
  // broad patches (pale hardpan, darker scrub soil) so open ground isn't one flat colour from above
  float gPatch = smoothstep(0.35, 0.75, gNoise(vGW * 0.06 + 17.0));
  float scrub = smoothstep(0.62, 0.8, gNoise(vGW * 0.11 - 5.0));
  // the dirt texture's grain, contrast-lifted around its (linear) mean so it survives the
  // top-down distance: the texture's sRGB mean (146, 111, 76) decoded, times the material tint
  vec3 gMean = vec3(0.288, 0.159, 0.073) * vec3(0.644, 0.617, 0.578);
  diffuseColor.rgb = max(gMean + (diffuseColor.rgb - gMean) * 1.6, vec3(0.0));
  vec3 dirt = diffuseColor.rgb * mix(vec3(1.03, 0.98, 0.9), vec3(0.84, 0.8, 0.76), n);
  dirt *= mix(vec3(1.0), vec3(0.9, 0.88, 0.86), gPatch);
  dirt = mix(dirt, dirt * vec3(0.78, 0.8, 0.66), scrub * 0.7);
  vec3 street = diffuseColor.rgb * vec3(0.78, 0.7, 0.62) * (0.9 + 0.2 * n);
  diffuseColor.rgb = mix(dirt, street, gM.g * 0.85);
  diffuseColor.rgb *= 1.0 - gM.b * 0.38;
  // Scrub tint out past the edge of town.
  float far = smoothstep(0.0, 40.0, max(max(-vGW.x, vGW.x - gSize), max(-vGW.y, vGW.y - gSize)));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.92, 0.94, 0.8), far * n);
}`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.86, gM.b * 0.5);',
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
reflectedLight.directDiffuse *= gM.r;
reflectedLight.directSpecular *= gM.r;
reflectedLight.indirectDiffuse *= mix(0.78, 1.0, gM.r);`,
      )
  }
  mat.customProgramCacheKey = () => 'ffa-ground'
  const mesh = new Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.name = 'ground'
  return mesh
}
