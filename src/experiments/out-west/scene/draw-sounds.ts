import type { ItemId } from '../data/catalog.ts'

export const DRAW_SOUNDS: Partial<Record<ItemId, { rate: number; gain: number; hawk?: boolean }>> =
  {
    'sound.thunder-crack': { rate: 1.25, gain: 0.7 },
    'sound.cannon-boom': { rate: 0.62, gain: 0.9 },
    'sound.thunderclap-hawk': { rate: 0.8, gain: 0.9, hawk: true },
  }

export const FRAME_COLORS: Readonly<Record<string, string>> = {
  'frame.pine-board': '#8a6a42',
  'frame.brass-tacks': '#c8a04a',
  'frame.gilt-saloon': '#e8c060',
  'frame.most-wanted-gilt': '#ffd870',
  'frame.midnight': '#2a2a40',
  'frame.most-wanted-dated': '#d8b45a',
  'frame.tall-tales': '#7a2a1e',
  'frame.legend': '#2a4a32',
}
