#!/usr/bin/env bun
/** Compatibility entrypoint for the canonical native-supported GLB optimizer. */
import { copyFile } from 'node:fs/promises'
import { optimizeAsset } from './content/optimize.ts'

const [input, output = input] = process.argv.slice(2)
if (!(input && output)) {
  throw new Error('usage: bun tools/optimize-gltf.ts <input.glb> [output.glb]')
}
if (input !== output) {
  await copyFile(input, output)
}
await optimizeAsset(output)
