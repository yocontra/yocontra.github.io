/**
 * Renders one full turn of the spinning face favicon off the main thread and posts the frames
 * back as PNG blobs. The page then only cycles cached object URLs (no per-frame encoding).
 */
const SIZE = 64

interface Request {
  src: string
  frames: number
}

// The DOM lib types the global scope as a Window; inside a worker it is a worker scope.
const scope = globalThis as unknown as Worker

scope.onmessage = (event: MessageEvent<Request>) => {
  const { src, frames } = event.data
  render(src, frames).then(
    (blobs) => scope.postMessage({ blobs }),
    () => scope.postMessage({ blobs: [] }),
  )
}

async function render(src: string, frames: number): Promise<Blob[]> {
  const image = await createImageBitmap(await (await fetch(src)).blob())
  const canvas = new OffscreenCanvas(SIZE, SIZE)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return []
  }
  const blobs: Blob[] = []
  for (let i = 0; i < frames; i++) {
    const sx = Math.cos((i / frames) * Math.PI * 2)
    ctx.clearRect(0, 0, SIZE, SIZE)
    ctx.save()
    ctx.translate(SIZE / 2, 0)
    // Keep a sliver visible edge-on so it never fully disappears.
    ctx.scale(Math.sign(sx || 1) * Math.max(Math.abs(sx), 0.06), 1)
    ctx.drawImage(image, -SIZE / 2, 0, SIZE, SIZE)
    ctx.restore()
    // Frames depend on each other's canvas state, so they are encoded in order.
    // biome-ignore lint/performance/noAwaitInLoops: sequential frames on one canvas
    blobs.push(await canvas.convertToBlob({ type: 'image/png' }))
  }
  return blobs
}
