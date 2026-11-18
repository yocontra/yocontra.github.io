/** Pixel coverage of a native white geometry mask; this does not judge art quality. */
export function frameObstruction(
  pixels: Uint8Array,
  { width, height, channels }: { width: number; height: number; channels: number },
) {
  if (width < 1 || height < 1 || channels < 1 || pixels.length !== width * height * channels) {
    throw new Error('Invalid native mask dimensions')
  }
  const regions = {
    total: { covered: 0, pixels: 0 },
    lowerHalf: { covered: 0, pixels: 0 },
    lowerCenter: { covered: 0, pixels: 0 },
  }
  const sample = (region: { covered: number; pixels: number }, covered: boolean) => {
    region.pixels++
    if (covered) {
      region.covered++
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Native post effects leave a faint background gradient below 64; the unlit mask is white.
      const covered = (pixels[(y * width + x) * channels] ?? 0) > 64
      sample(regions.total, covered)
      if (y >= height / 2) {
        sample(regions.lowerHalf, covered)
      }
      if (x >= width * 0.35 && x < width * 0.65 && y >= height * 0.5 && y < height * 0.8) {
        sample(regions.lowerCenter, covered)
      }
    }
  }
  if (regions.total.covered === 0) {
    throw new Error('Native arms mask is empty; hiding the viewmodel cannot pass this probe')
  }
  return Object.fromEntries(
    Object.entries(regions).map(([name, region]) => [
      name,
      { ...region, ratio: region.pixels === 0 ? 0 : region.covered / region.pixels },
    ]),
  )
}
