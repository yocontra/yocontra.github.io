/** Approximate step-band masking from a game output capture and its simultaneously recorded feet stem. */
/** 5 ms band powers (1.5–6 kHz, where a heel's click is heard) of a recording. */
async function bandFrames(file: string, gainDb = 0): Promise<number[]> {
  const raw =
    await Bun.$`ffmpeg -loglevel error -i ${file} -af highpass=f=1500,lowpass=f=6000,volume=${gainDb}dB -ac 1 -ar 24000 -f f32le -`
      .quiet()
      .arrayBuffer()
  const x = new Float32Array(raw)
  const len = 120
  return Array.from({ length: Math.floor(x.length / len) }, (_, f) => {
    let sum = 0
    for (let i = f * len; i < (f + 1) * len; i++) {
      sum += (x[i] ?? 0) ** 2
    }
    return sum / len
  })
}

/** The stem's offset against the full mix, frames: where it least often exceeds the mix it is in. */
function stemLag(full: number[], stem: number[]): number {
  let best = { lag: 0, over: Number.POSITIVE_INFINITY }
  for (let lag = -40; lag <= 40; lag++) {
    let over = 0
    for (let f = 50; f < Math.min(full.length, stem.length) - 50; f++) {
      over += (stem[f + lag] ?? 0) > (full[f] ?? 0) * 1.05 ? 1 : 0
    }
    if (over < best.over) {
      best = { lag, over }
    }
  }
  return best.lag
}

/**
 * Each step onset in the feet stem against everything else in the same band over the next 60 ms:
 * the share of onsets no more than 6 dB under the rest, and
 * the median step-to-rest ratio. This boots/gear stem includes own and enemy riders; it is
 * a band-energy proxy, not proof of enemy localization or a perceptual audibility verdict. The stem is taken before the master's 3 dB input and 2 dB output trims.
 */
export async function footstepMasking(
  fullFile: string,
  footstepsFile: string,
): Promise<{ steps: number; audible: number; medianDb: number }> {
  const full = await bandFrames(fullFile)
  const raw = await bandFrames(footstepsFile, -5)
  const lag = stemLag(full, raw)
  const feet = full.map((_, f) => raw[f + lag] ?? 0)
  const dB = (p: number) => 10 * Math.log10(p + 1e-12)
  const loud = Math.max(...feet)
  const ratios: number[] = []
  for (let f = 4; f < feet.length - 12; f++) {
    const before = ((feet[f - 4] ?? 0) + (feet[f - 3] ?? 0) + (feet[f - 2] ?? 0)) / 3
    if (dB(feet[f] ?? 0) < dB(loud) - 30 || dB(feet[f] ?? 0) < dB(before) + 6) {
      continue
    }
    let step = 0
    let rest = 0
    for (let k = f; k < f + 12; k++) {
      step += feet[k] ?? 0
      rest += Math.max((full[k] ?? 0) - (feet[k] ?? 0), 1e-10)
    }
    ratios.push(dB(step) - dB(rest))
    f += 12
  }
  ratios.sort((a, b) => a - b)
  return {
    steps: ratios.length,
    audible: Math.round((100 * ratios.filter((r) => r > -6).length) / Math.max(1, ratios.length)),
    medianDb: Math.round((ratios[Math.floor(ratios.length / 2)] ?? 0) * 10) / 10,
  }
}
if (import.meta.main) {
  const [full, feet] = process.argv.slice(2)
  if (!(full && feet)) {
    throw new Error('Usage: bun tools/audio/footstep-mask.ts full.wav feet.wav')
  }
  console.log(JSON.stringify(await footstepMasking(full, feet)))
}
