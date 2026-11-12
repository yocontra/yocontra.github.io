import { getSettings } from '../settings.ts'
import { readDevice } from './device.ts'

export type RenderTier = 'low' | 'high'

/** `#tier=` wins, then the saved graphics setting; phones start at the floor. */
export function pickTier(
  param: string | null = new URLSearchParams(globalThis.location?.hash.slice(1) ?? '').get('tier'),
): RenderTier {
  if (param === 'low' || param === 'high') {
    return param
  }
  const chosen = getSettings().graphics
  if (chosen !== 'auto') {
    return chosen
  }
  // iPads, foldables and desktops take the device prior.
  return readDevice().form === 'phone' ? 'low' : 'high'
}
