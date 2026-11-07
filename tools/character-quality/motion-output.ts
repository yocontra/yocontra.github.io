/** Retire generated evidence before a recapture, including when its replacement later fails. */
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const generated = new Set([
  'alive.png',
  'filmstrip.png',
  'body-filmstrip.png',
  'video-filmstrip.png',
  'video-filmstrip-source.json',
  'video-filmstrip-provenance.json',
  'video-frames',
  'motion.webm',
  'motion.json',
])
const generatedImage = /^(?:frame-\d+|gear-[\w-]+)\.png$/u

export function clearMotionOutput(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (generated.has(name) || generatedImage.test(name)) {
      rmSync(join(dir, name), { recursive: true, force: true })
    }
  }
}
