#!/usr/bin/env bun
/**
 * Derive normal, roughness and AO from a flat, shadowless albedo (design doc
 * §10.2). For bespoke Gemini textures (signage, posters, leather tooling);
 * generic materials should come from Poly Haven scans instead.
 *
 *   bun tools/pbr-from-albedo.ts <albedo.(png|webp|jpg)> <out_prefix> [options]
 *
 *   --strength 2.0     normal strength (Sobel on the height)
 *   --rough 0.55,0.85  roughness range (bright → low end; leather 0.55–0.75, metal 0.25–0.45)
 *   --radius 24        high-pass radius in px (bigger keeps broader shapes)
 *   --ao 0.6           cavity AO strength
 *   --size 1024        output size (square)
 *   --q 90             WebP quality
 *
 * Writes <out_prefix>_nor.webp (OpenGL +Y), <out_prefix>_arm.webp
 * (R = AO, G = roughness, B = metalness 0) and, if the input isn't WebP,
 * <out_prefix>_diff.webp. Tiling is preserved (all filters wrap).
 * Requires ffmpeg (decode/resize) and cwebp.
 *
 * Pipeline: height = luminance high-pass (box blur subtracted, wrapped);
 * normal = Sobel(height) × strength; roughness = inverted luminance remapped
 * into the range; AO = cavity (how far a texel sits below its blurred
 * neighbourhood).
 */
import { spawnSync } from 'node:child_process'
import { rm, stat } from 'node:fs/promises'

interface Opts {
  input: string
  out: string
  strength: number
  rough: [number, number]
  radius: number
  ao: number
  size: number
  quality: number
}

function parse(argv: string[]): Opts {
  const [input, out] = argv
  if (!(input && out)) {
    throw new Error(
      'usage: bun tools/pbr-from-albedo.ts <albedo> <out_prefix> [--strength 2] [--rough 0.55,0.85] ...',
    )
  }
  const flag = (k: string, d: string) => {
    const i = argv.indexOf(k)
    return i >= 0 ? (argv[i + 1] ?? d) : d
  }
  const [r0, r1] = flag('--rough', '0.55,0.85').split(',').map(Number)
  return {
    input,
    out,
    strength: Number(flag('--strength', '2')),
    rough: [r0 ?? 0.55, r1 ?? 0.85],
    radius: Number(flag('--radius', '24')),
    ao: Number(flag('--ao', '0.6')),
    size: Number(flag('--size', '1024')),
    quality: Number(flag('--q', '90')),
  }
}

function run(cmd: string, args: string[]): Buffer {
  const p = spawnSync(cmd, args, { maxBuffer: 1 << 28 })
  if (p.status !== 0) {
    throw new Error(`${cmd} failed: ${p.stderr.toString().slice(0, 400)}`)
  }
  return p.stdout
}

/** Decode any image to RGBA8 at size×size via ffmpeg. */
function decode(path: string, size: number): Uint8Array {
  const raw = run('ffmpeg', [
    '-v',
    'error',
    '-i',
    path,
    '-vf',
    `scale=${size}:${size}:flags=lanczos`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-',
  ])
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
}

async function encode(
  rgba: Uint8Array,
  size: number,
  dest: string,
  quality: number,
): Promise<void> {
  const tmp = `${dest}.png`
  // raw RGBA on stdin → lossless PNG → WebP
  const p = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${size}x${size}`,
      '-i',
      '-',
      tmp,
    ],
    { input: rgba },
  )
  if (p.status !== 0) {
    throw new Error(`ffmpeg encode failed: ${p.stderr.toString().slice(0, 400)}`)
  }
  run('cwebp', ['-quiet', '-q', String(quality), '-m', '6', '-exact', tmp, '-o', dest])
  await rm(tmp)
  console.log(`${dest}  ${((await stat(dest)).size / 1024).toFixed(0)} KB`)
}

/** Wrapped separable box blur (two passes ≈ a tent). */
function blur(src: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(n * n)
  const out = new Float32Array(n * n)
  const k = 1 / (2 * r + 1)
  const w = (i: number) => ((i % n) + n) % n
  for (let y = 0; y < n; y++) {
    let acc = 0
    for (let i = -r; i <= r; i++) {
      acc += src[y * n + w(i)] ?? 0
    }
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = acc * k
      acc += (src[y * n + w(x + r + 1)] ?? 0) - (src[y * n + w(x - r)] ?? 0)
    }
  }
  for (let x = 0; x < n; x++) {
    let acc = 0
    for (let i = -r; i <= r; i++) {
      acc += tmp[w(i) * n + x] ?? 0
    }
    for (let y = 0; y < n; y++) {
      out[y * n + x] = acc * k
      acc += (tmp[w(y + r + 1) * n + x] ?? 0) - (tmp[w(y - r) * n + x] ?? 0)
    }
  }
  return out
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2))
  const n = o.size
  const rgba = decode(o.input, n)
  const lum = new Float32Array(n * n)
  for (let i = 0; i < n * n; i++) {
    lum[i] =
      (0.2126 * (rgba[i * 4] ?? 0) +
        0.7152 * (rgba[i * 4 + 1] ?? 0) +
        0.0722 * (rgba[i * 4 + 2] ?? 0)) /
      255
  }
  // height: high-pass luminance, normalised to 0..1
  const low = blur(blur(lum, n, o.radius), n, o.radius)
  const height = new Float32Array(n * n)
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (let i = 0; i < n * n; i++) {
    const h = (lum[i] ?? 0) - (low[i] ?? 0)
    height[i] = h
    lo = Math.min(lo, h)
    hi = Math.max(hi, h)
  }
  const span = Math.max(1e-6, hi - lo)
  for (let i = 0; i < n * n; i++) {
    height[i] = ((height[i] ?? 0) - lo) / span
  }
  const at = (x: number, y: number) => height[(((y % n) + n) % n) * n + (((x % n) + n) % n)] ?? 0
  // normal: Sobel on height (OpenGL convention, +Y up)
  const nor = new Uint8Array(n * n * 4)
  // AO: cavity = how far below the local mean
  const near = blur(height, n, 3)
  const arm = new Uint8Array(n * n * 4)
  const [r0, r1] = o.rough
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x - 1, y) -
        at(x - 1, y + 1)
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        at(x - 1, y - 1) -
        2 * at(x, y - 1) -
        at(x + 1, y - 1)
      let nx = -gx * o.strength
      let ny = gy * o.strength
      let nz = 1
      const len = Math.hypot(nx, ny, nz)
      nx /= len
      ny /= len
      nz /= len
      const i = y * n + x
      nor.set([(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255, 255], i * 4)
      const cavity = Math.max(0, (near[i] ?? 0) - (height[i] ?? 0))
      const ao = Math.max(0, 1 - cavity * 4 * o.ao)
      const rough = r1 - (lum[i] ?? 0) * (r1 - r0)
      arm.set([ao * 255, rough * 255, 0, 255], i * 4)
    }
  }
  await encode(nor, n, `${o.out}_nor.webp`, Math.min(100, o.quality + 5))
  await encode(arm, n, `${o.out}_arm.webp`, o.quality)
  if (!o.input.endsWith('.webp')) {
    run('cwebp', [
      '-quiet',
      '-q',
      String(o.quality),
      '-m',
      '6',
      '-resize',
      String(n),
      String(n),
      o.input,
      '-o',
      `${o.out}_diff.webp`,
    ])
  }
}

await main()
