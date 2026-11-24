import sleeves from './fitted-sleeves.json' with { type: 'json' }
import type { ContentAsset } from './types.ts'
import { VIEWMODELS } from './viewmodels.ts'

/** Dressed sleeves use the same fitted jacket as the third-person model. */
export const outfitArms: Readonly<Record<string, ContentAsset>> = { ...VIEWMODELS, ...sleeves }
