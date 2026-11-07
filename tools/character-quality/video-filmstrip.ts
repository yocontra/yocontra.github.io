/** Extract chronological 200ms frames from the actual recorded native canvas, without resimulating. */
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'

const base = '.playwright-mcp/quality/physical-motion'
for (const name of readdirSync(base)) {
  const dir = join(base, name)
  const video = Bun.file(join(dir, 'motion.webm'))
  if (!(await video.exists())) {
    continue
  }
  const extracted = join(dir, 'video-frames')
  mkdirSync(extracted, { recursive: true })
  const result = Bun.spawnSync([
    'ffmpeg',
    '-v',
    'error',
    '-i',
    video.name ?? '',
    '-vf',
    'fps=5,scale=1280:800',
    '-t',
    '4.8',
    '-y',
    join(extracted, 'frame-%03d.png'),
  ])
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString())
  }
  const cells: OverlayOptions[] = []
  const w = 512
  const h = 344
  const cols = 3
  for (const [i, file] of readdirSync(extracted)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .entries()) {
    const left = (i % cols) * w
    const top = Math.floor(i / cols) * h
    const ms = i * 200
    const image = sharp(join(extracted, file))
    const label = Buffer.from(
      `<svg width="512" height="24"><rect width="100%" height="100%" fill="#211c18"/><text x="8" y="17" fill="#f5e7ca" font-size="13">video ${ms}ms</text></svg>`,
    )
    cells.push(
      {
        input: await image
          .resize(w, 320, { fit: 'contain', background: '#211c18' })
          .png()
          .toBuffer(),
        left,
        top,
      },
      { input: label, left, top: top + 320 },
    )
  }
  await sharp({
    create: {
      width: cols * w,
      height: Math.ceil(cells.length / 2 / cols) * h,
      channels: 3,
      background: '#211c18',
    },
  })
    .composite(cells)
    .png()
    .toFile(join(dir, 'video-filmstrip.png'))
  console.log(`${name}: actual recorded 200ms filmstrip`)
}
