/**
 * A wanted poster in its frame, printed on torn stock: name, level, live bounty, streak and kit.
 * Shared by the match intro, the results sheet's opponent and public profiles.
 */
import type { Poster } from '../contract/duel.ts'
import { itemById, normalizeLoadout } from '../data/catalog.ts'
import { money } from '../data/economy.ts'
import { titleFor } from '../data/progression.ts'
import { FRAME_COLORS } from '../scene/draw-sounds.ts'
import { type IconName, icon } from './icons.ts'
import { el } from './sheet.ts'

const KIND_HEAD: Record<Poster['kind'], string> = {
  human: 'Wanted',
  ghost: 'Ghost of',
  // the name already reads "Town Outlaw": a second "Town outlaw" heading just stutters
  outlaw: 'Wanted',
}

const OUTLAW_NAME = /outlaw/iu

const KIT_ICON: Record<'hat' | 'gun' | 'outfit' | 'extra', IconName> = {
  hat: 'hat',
  gun: 'revolver',
  outfit: 'coat',
  extra: 'badge',
}

/** A wanted poster in its frame: name, level, live bounty, streak and kit, printed on torn stock. */
export function posterEl(p: Poster, side: 'you' | 'them'): HTMLElement {
  const l = normalizeLoadout(p.loadout)
  const card = el('div', `ow-wanted ow-wanted-${side}`)
  card.dataset.kind = p.kind
  card.style.setProperty('--frame', FRAME_COLORS[l.frame] ?? '#8a6a42')
  const sheet = el('div', 'ow-wanted-sheet', card)
  el('div', 'ow-wanted-head', sheet, KIND_HEAD[p.kind])
  el('div', 'ow-wanted-sub', sheet, p.kind === 'ghost' ? 'A recorded gun' : 'Dead or alive')
  el('div', 'ow-wanted-name', sheet, p.name)
  el('div', 'ow-wanted-meta', sheet, `Level ${p.level} · ${titleFor(p.level)}`)
  const bounty = el('div', 'ow-wanted-bounty', sheet)
  el('span', 'ow-wanted-amount', bounty, money(p.bounty))
  el('span', 'ow-wanted-reward', bounty, 'Reward')
  const notes: string[] = []
  if (p.streak > 1) {
    notes.push(`${p.streak}-win streak`)
  }
  if (p.cowardice > 0) {
    notes.push(`${p.cowardice} cowardice`)
  }
  if (p.kind === 'outlaw' && !OUTLAW_NAME.test(p.name)) {
    notes.push('a town outlaw')
  }
  el('div', 'ow-wanted-notes', sheet, notes.join(' · ') || 'Clean record')
  const kit = el('ul', 'ow-wanted-kit', sheet)
  for (const slot of ['hat', 'gun', 'outfit', 'extra'] as const) {
    const id = l[slot]
    const item = id ? itemById(id) : undefined
    if (item && item.source !== 'starter') {
      const li = el('li', '', kit)
      li.append(icon(KIT_ICON[slot]), item.name)
    }
  }
  if (kit.children.length === 0) {
    el('li', '', kit, 'Starter kit')
  }
  return card
}
