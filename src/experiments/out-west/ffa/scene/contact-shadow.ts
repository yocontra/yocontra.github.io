/** Each batch owns its radial map so disposing a crowd cannot invalidate another batch. */
import { CanvasTexture, SRGBColorSpace } from 'three'

export function contactShadowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const context = canvas.getContext('2d')
  if (context) {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32)
    gradient.addColorStop(0, 'rgba(0,0,0,0.5)')
    gradient.addColorStop(0.55, 'rgba(0,0,0,0.24)')
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, 64, 64)
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}
