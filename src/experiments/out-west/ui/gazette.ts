/**
 * The Perdition Gazette (meta-game stream): a front page between outlaws, the boss epilogue, and
 * the credits after it. Each page shows once on a device as part of the run (the duel waits on
 * it through `meta/events.ts` `interlude`), and every page read can be read again from the map.
 * Any press turns the page; nothing here can fire a shot.
 */
import { CREDITS, EPILOGUE, type FrontPage, frontPage } from '../data/gazette.ts'
import { OUTLAWS } from '../data/outlaws.ts'
import { type Interlude, setInterlude } from '../meta/events.ts'
import type { Meta } from '../meta/progress.ts'
import { uiSound } from './sfx.ts'
import { button, el, panelSheet, swallow } from './sheet.ts'

/** A page can't be dismissed for this long (the press that won the duel isn't a page turn). */
const READ_GRACE_MS = 900
const EPILOGUE_SLOT = 17

const dateline = (issue: number): string => `No. ${issue} · Perdition, A.T. · Price five cents`

/** Paints one front page into `parent`. */
function page(
  parent: HTMLElement,
  p: { issue: number; headline: string; lines: readonly string[]; kicker?: string },
  outlaw: number | null,
): void {
  el('div', 'ow-gz-mast ow-t-ornate', parent, 'The Perdition Gazette')
  el('div', 'ow-gz-date', parent, dateline(p.issue))
  if (p.kicker) {
    el('div', 'ow-gz-kicker', parent, p.kicker)
  }
  el('h2', 'ow-gz-head', parent, p.headline)
  const cols = el('div', 'ow-gz-cols', parent)
  for (const line of p.lines) {
    el('p', 'ow-gz-p', cols, line)
  }
  const o = outlaw === null ? undefined : OUTLAWS[outlaw]
  if (o) {
    el('div', 'ow-gz-wanted', parent, `Wanted: ${o.name}, ${o.epithet}. ${o.hook}`)
  }
}

/** A full-screen sheet that resolves when the reader turns the page. */
function overlay(
  root: HTMLElement,
  cls: string,
  paint: (paper: HTMLElement) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const back = el('div', `ow-gz ${cls}`, root)
    back.setAttribute('role', 'dialog')
    back.setAttribute('aria-label', 'The Perdition Gazette')
    swallow(back)
    const paper = el('article', 'ow-gz-paper', back)
    paint(paper)
    const hint = el('div', 'ow-gz-hint', back, 'press to read on')
    const opened = performance.now()
    uiSound('uiStamp')
    let done = false
    const close = (): void => {
      if (done || performance.now() - opened < READ_GRACE_MS) {
        return
      }
      done = true
      globalThis.removeEventListener('keydown', onKey, true)
      back.classList.add('off')
      setTimeout(() => back.remove(), 300)
      resolve()
    }
    const onKey = (e: KeyboardEvent): void => {
      // the page owns the keys while it's up: Space must not reach the duel
      e.preventDefault()
      e.stopImmediatePropagation()
      close()
    }
    globalThis.addEventListener('keydown', onKey, true)
    back.addEventListener('pointerup', (e) => {
      e.stopPropagation()
      close()
    })
    setTimeout(() => hint.classList.add('on'), READ_GRACE_MS)
    requestAnimationFrame(() => back.classList.add('on'))
  })
}

export function showFrontPage(root: HTMLElement, slot: number): Promise<void> | null {
  const p: FrontPage | null = frontPage(slot)
  if (!p) {
    return null
  }
  return overlay(root, 'ow-gz-front', (paper) => page(paper, p, slot))
}

export async function showEpilogue(root: HTMLElement): Promise<void> {
  await overlay(root, 'ow-gz-epilogue', (paper) => page(paper, EPILOGUE, null))
  await overlay(root, 'ow-gz-credits', (paper) => {
    el('div', 'ow-gz-mast ow-t-ornate', paper, 'Out West')
    el('div', 'ow-gz-date', paper, 'The end')
    const list = el('dl', 'ow-gz-credits-list', paper)
    for (const c of CREDITS) {
      el('dt', '', list, c.role)
      el('dd', '', list, c.name)
    }
  })
}

/**
 * The Gazette between duels: each front page once per device, the epilogue and credits the first
 * time Hardin falls (and on every clear after, the epilogue alone is skipped). Legend runs skip it.
 */
export function installGazette(root: HTMLElement, meta: Meta): void {
  setInterlude((i: Interlude) => {
    if (i.kind === 'next') {
      if (meta.hasRead(i.level)) {
        return null
      }
      const shown = showFrontPage(root, i.level)
      return shown ? shown.then(() => meta.readGazette(i.level)) : null
    }
    if (i.legend || meta.hasRead(EPILOGUE_SLOT)) {
      return null
    }
    return showEpilogue(root).then(() => meta.readGazette(EPILOGUE_SLOT))
  })
}

/** The back issues: every page this device has read, newest first. */
export function openBackIssues(root: HTMLElement, meta: Meta): void {
  const s = panelSheet(root, { title: 'The Gazette', paper: true, cls: 'ow-gz-issues' })
  const slots = [...meta.data.stats.gazette].sort((a, b) => b - a)
  if (meta.hasRead(EPILOGUE_SLOT)) {
    slots.unshift(EPILOGUE_SLOT)
  }
  if (slots.length === 0) {
    el('p', 'ow-hub-note', s.body, 'No papers yet. Beat Bret Barsh and the Gazette will print.')
    return
  }
  const list = el('ul', 'ow-ledger-list ow-gz-list', s.body)
  for (const slot of slots) {
    const p = slot === EPILOGUE_SLOT ? EPILOGUE : frontPage(slot)
    if (!p) {
      continue
    }
    const li = el('li', '', list)
    el('span', '', li, `No. ${p.issue}`)
    button(li, p.headline, () => {
      s.close()
      const read =
        slot === EPILOGUE_SLOT
          ? showEpilogue(root)
          : (showFrontPage(root, slot) ?? Promise.resolve())
      read.catch(() => undefined)
    })
  }
}
