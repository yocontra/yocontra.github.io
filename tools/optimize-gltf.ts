#!/usr/bin/env bun
/** Compatibility entrypoint for the canonical native-supported GLB optimizer. */
import { copyFile } from 'node:fs/promises'
import { optimizeAsset, parseTextureQuality } from './content/optimize.ts'

const args = process.argv.slice(2)
const quality = parseTextureQuality(args.find((arg) => arg.startsWith('--textures='))?.slice(11))
const [input, output = input] = args.filter((arg) => !arg.startsWith('--textures='))
if (!(input && output)) {
  throw new Error('usage: bun tools/optimize-gltf.ts <input.glb> [output.glb] [--textures=profile]')
}
if (input !== output) {
  await copyFile(input, output)
}
await optimizeAsset(output, quality)
