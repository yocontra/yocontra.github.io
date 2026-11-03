#!/usr/bin/env bun
/**
 * The design doc §10.3 optimisation chain for a GLB, via the gltf-transform
 * CLI (fetched on demand with bunx; no project dependency):
 *
 *   dedup → prune → weld → resize → textures (KTX2 if `toktx` is installed,
 *   else WebP) → quantize → meshopt
 *
 *   bun tools/optimize-gltf.ts <in.glb> <out.glb> [--tex 1024] [--ktx uastc|etc1s|off] [--lod 0.25] [--error 0.01]
 *
 *   --tex 1024     max texture size (2048 hero / 1024 / 512 FFA)
 *   --ktx etc1s    KTX2/Basis mode (uastc for normals and hero albedo, etc1s
 *                  for props). Needs KTX-Software's `toktx` on PATH
 *                  (brew install ktx); without it, textures go to WebP.
 *   --lod 0.25     also simplify to this triangle ratio (meshoptimizer), for
 *                  LOD1/LOD2 files: writes <out>.lod.glb
 *   --error 0.01   simplifier error bound
 *
 * The output loads with the existing GLTFLoader + MeshoptDecoder in
 * engine/assets.ts. KTX2 output also needs a KTX2Loader (basis transcoder in
 * public/) wired into assets.ts: see tools/README.md.
 */
import { spawnSync } from 'node:child_process'
import { copyFile, rm, stat } from 'node:fs/promises'

const GLB_EXT = /\.glb$/u
const CLI = ['x', '--bun', '@gltf-transform/cli@4']

function flag(argv: string[], k: string, d: string): string {
  const i = argv.indexOf(k)
  return i >= 0 ? (argv[i + 1] ?? d) : d
}

function gt(args: string[]): void {
  const p = spawnSync('bun', [...CLI, ...args], { stdio: 'inherit' })
  if (p.status !== 0) {
    throw new Error(`gltf-transform ${args[0]} failed`)
  }
}

function hasToktx(): boolean {
  return spawnSync('toktx', ['--version']).status === 0
}

async function kb(path: string): Promise<string> {
  return `${((await stat(path)).size / 1024).toFixed(0)} KB`
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const [input, out] = argv
  if (!(input && out)) {
    throw new Error(
      'usage: bun tools/optimize-gltf.ts <in.glb> <out.glb> [--tex 1024] [--ktx etc1s] [--lod 0.25]',
    )
  }
  const tex = flag(argv, '--tex', '1024')
  const ktx = flag(argv, '--ktx', 'etc1s')
  const lod = Number(flag(argv, '--lod', '0'))
  const error = flag(argv, '--error', '0.01')
  const tmp = `${out}.tmp.glb`
  await copyFile(input, tmp)
  const step = (cmd: string, ...rest: string[]) => gt([cmd, tmp, tmp, ...rest])
  step('dedup')
  step('prune')
  step('weld')
  step('resize', '--width', tex, '--height', tex)
  if (ktx !== 'off' && hasToktx()) {
    step(ktx === 'uastc' ? 'uastc' : 'etc1s')
  } else {
    if (ktx !== 'off') {
      console.warn('toktx not found: textures go to WebP instead of KTX2 (brew install ktx)')
    }
    step('webp')
  }
  step('quantize')
  if (lod > 0) {
    const lodTmp = `${out}.lod.tmp.glb`
    await copyFile(tmp, lodTmp)
    gt(['simplify', lodTmp, lodTmp, '--ratio', String(lod), '--error', error])
    gt(['meshopt', lodTmp, `${out.replace(GLB_EXT, '')}.lod.glb`])
    await rm(lodTmp)
  }
  gt(['meshopt', tmp, out])
  await rm(tmp)
  console.log(`${input} (${await kb(input)}) -> ${out} (${await kb(out)})`)
}

await main()
