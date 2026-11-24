// Each shop commissioned one set of boards. The bank reuses its house lettering indoors.
type Face = 'rye' | 'ultra' | 'oswald-600' | 'eb-garamond' | 'eb-garamond-italic'
type Trim = 'pinstripe' | 'cartouche' | 'keyline' | 'rail' | 'bare'
type Mark = 'diamond' | 'star' | 'wing' | 'shoe' | 'anvil' | 'none'

export interface SignPaint {
  face: Face
  ground: string
  ink: string
  trim: string
  frame: Trim
  mark: Mark
  spacing: number // em
  mixedCase?: boolean
  shade?: string
}

const shops: Record<string, SignPaint> = {
  saloon: {
    face: 'rye',
    ground: '#5b2521',
    ink: '#ffe5ad',
    trim: '#cc965c',
    frame: 'cartouche',
    mark: 'diamond',
    spacing: 0.012,
    shade: '#331917',
  },
  hotel: {
    face: 'eb-garamond-italic',
    ground: '#203e39',
    ink: '#f7dfaa',
    trim: '#c6a267',
    frame: 'pinstripe',
    mark: 'wing',
    spacing: 0.025,
    mixedCase: true,
  },
  bank: {
    face: 'eb-garamond',
    ground: '#282e34',
    ink: '#fae5b5',
    trim: '#ba9660',
    frame: 'keyline',
    mark: 'none',
    spacing: 0.065,
  },
  livery: {
    face: 'ultra',
    ground: '#c59768',
    ink: '#35251d',
    trim: '#67472d',
    frame: 'bare',
    mark: 'shoe',
    spacing: 0,
  },
  general_store: {
    face: 'eb-garamond',
    ground: '#efd8a5',
    ink: '#304840',
    trim: '#83653c',
    frame: 'cartouche',
    mark: 'diamond',
    spacing: 0.015,
    mixedCase: true,
    shade: '#c8ad72',
  },
  jail: {
    face: 'oswald-600',
    ground: '#e0d8be',
    ink: '#293b42',
    trim: '#5e6970',
    frame: 'keyline',
    mark: 'star',
    spacing: 0.095,
  },
  depot: {
    face: 'oswald-600',
    ground: '#223b4b',
    ink: '#f7e7c4',
    trim: '#caac73',
    frame: 'rail',
    mark: 'none',
    spacing: 0.085,
  },
  stage_line: {
    face: 'ultra',
    ground: '#e8c997',
    ink: '#702e24',
    trim: '#91553b',
    frame: 'rail',
    mark: 'wing',
    spacing: 0.005,
  },
  assay: {
    face: 'eb-garamond',
    ground: '#314950',
    ink: '#f5daa0',
    trim: '#caa461',
    frame: 'pinstripe',
    mark: 'diamond',
    spacing: 0.09,
  },
  smithy: {
    face: 'oswald-600',
    ground: '#43342b',
    ink: '#f2d7aa',
    trim: '#a87b52',
    frame: 'bare',
    mark: 'anvil',
    spacing: 0.035,
  },
  undertaker: {
    face: 'eb-garamond',
    ground: '#292728',
    ink: '#eee2ce',
    trim: '#a59a82',
    frame: 'pinstripe',
    mark: 'none',
    spacing: 0.045,
    mixedCase: true,
  },
  church: {
    face: 'eb-garamond-italic',
    ground: '#e4ddc7',
    ink: '#373c47',
    trim: '#827968',
    frame: 'bare',
    mark: 'none',
    spacing: 0.025,
    mixedCase: true,
  },
}

export function signPaint(owner: string) {
  const paint = shops[owner]
  if (!paint) {
    throw new Error(`Missing painted sign design for ${owner}`)
  }
  return paint
}

const marks: Record<Mark, string> = {
  none: '',
  diamond: '<path d="M-16 0l16-9 16 9-16 9z M-24-1h4v2h-4z M20-1h4v2h-4z"/>',
  wing: '<path d="M-29 -5H18l10 5H-15z M-17 3h33l-7 4H-7z"/>',
  shoe: '<path d="M-12-15 C-25 8-13 20 0 20S25 8 12-15l-7 4C20 11 5 17 0 15s-18-4-5-26z"/>',
  star: '<path d="M0-19 5-6 18-6 8 3 12 16 0 8-12 16-8 3-18-6-5-6z"/>',
  anvil: '<path d="M-29-10H25v7H16l-7 8v6l9 4v3h-33v-3l9-4V5l-7-7q-11 0-16-8z"/>',
}

export function boardDecoration(paint: SignPaint, width: number, showMark: boolean) {
  const right = width - 8
  let frame = ''
  switch (paint.frame) {
    case 'rail':
      frame = `<path d="M0 7H${width}M0 121H${width}" stroke-width="5"/>`
      break
    case 'pinstripe':
      frame = `<rect x="6" y="6" width="${width - 12}" height="116"/><rect x="11" y="11" width="${width - 22}" height="106" stroke-width="1"/>`
      break
    case 'keyline':
      frame = `<rect x="8" y="8" width="${width - 16}" height="112" stroke-width="3"/>`
      break
    case 'cartouche':
      frame = `<path d="M22 8H${right - 14}q0 14 14 14v84q-14 0-14 14H22q0-14-14-14V22q14 0 14-14z"/>`
      break
    default:
      break
  }
  const mark = showMark ? marks[paint.mark] : ''
  return `<g fill="none" stroke="${paint.trim}" stroke-width="2">${frame}</g><g fill="${paint.trim}"><g transform="translate(48 64)">${mark}</g><g transform="translate(${width - 48} 64) scale(-1 1)">${mark}</g></g>`
}
