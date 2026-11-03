// biome-ignore-all lint/complexity/noExcessiveLinesPerFunction: one self-contained in-page probe (Playwright serialises it, so no helpers outside it)
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: one self-contained in-page probe
// biome-ignore-all lint/security/noSecrets: the long strings are CSS selectors
/**
 * The in-page half of `tools/ui-audit.ts`. `probe` runs inside the page (Playwright serialises the
 * function's source), so it must not reference anything outside its own body.
 *
 * For every visible element under the screen's scope it checks:
 *  - overflow: an element's text runs outside its own box (left or right; scrollWidth misses
 *    text that overflows to the left, so the text's Range is measured against the box)
 *  - clip:     text cut off by a clipping ancestor (overflow hidden/clip) or the viewport
 *  - ellipsis: text truncated with an ellipsis or a line clamp (an error on short text)
 *  - overlap:  two different elements' text lines overlap on screen
 *  - tap:      an interactive control smaller than the tap size (44 px on touch)
 *  - font:     an interactive control whose font-family doesn't start with a game face
 *  - state:    a disabled primary button on a results receipt (an action that can't happen)
 *  - wrap:     a heading row's button wrapped under its heading
 *  - break:    a word (3 to 12 letters) split across two lines
 *  - clip also covers text faded by a scroll strip's edge mask when nothing scrolls
 */

export interface ProbeArgs {
  /** CSS selector of the screen's root; with `last`, only its last visible match. */
  scope: string
  last: boolean
  /** Minimum tap size in CSS px. */
  tap: number
  /** Subtrees to ignore (owned elsewhere, decorative). */
  skip: string[]
  /** Faces an interactive control may start its font-family with. */
  fonts: string[]
  /** Truncated text this short (in characters) is an error. */
  shortText: number
  /** Check for disabled primary buttons under this selector. */
  deadPrimary: string | null
}

export interface Finding {
  kind:
    | 'overflow'
    | 'clip'
    | 'ellipsis'
    | 'overlap'
    | 'tap'
    | 'font'
    | 'state'
    | 'wrap'
    | 'break'
    | 'scope'
  el: string
  text: string
  detail: string
}

export function probe(a: ProbeArgs): Finding[] {
  const out: Finding[] = []
  const all = [...document.querySelectorAll<HTMLElement>(a.scope)].filter((e) =>
    e.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
  )
  const roots = a.last ? all.slice(-1) : all
  if (roots.length === 0) {
    return [{ kind: 'scope', el: a.scope, text: '', detail: 'screen not found or not visible' }]
  }
  const tol = 1.5
  const nameOf = (e: Element): string => {
    const cls = [...e.classList].slice(0, 3).join('.')
    return `${e.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`
  }
  const ownText = (e: Element): string =>
    [...e.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .replace(/\s+/gu, ' ')
      .trim()
  const textOf = (e: Element): string =>
    (e.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 60)
  const skipped = (e: Element): boolean =>
    a.skip.some((s) => e.closest(s) !== null) || e.closest('[aria-hidden="true"]') !== null
  const visible = (e: Element): boolean => {
    if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      return false
    }
    const r = e.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const els: HTMLElement[] = []
  for (const root of roots) {
    for (const e of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      if (!(els.includes(e) || skipped(e)) && visible(e)) {
        els.push(e)
      }
    }
  }
  const range = document.createRange()
  const textRect = (e: Element): DOMRect => {
    range.selectNodeContents(e)
    return range.getBoundingClientRect()
  }
  /** The nearest ancestor that clips (or scrolls) its content. */
  const clipper = (e: Element): { el: HTMLElement; scrolls: boolean } | null => {
    for (let p = e.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      for (const o of [cs.overflowX, cs.overflowY]) {
        if (o === 'auto' || o === 'scroll') {
          return { el: p, scrolls: true }
        }
        if (o === 'hidden' || o === 'clip') {
          return { el: p, scrolls: false }
        }
      }
    }
    return null
  }
  const leaves = els.filter((e) => ownText(e).length > 0)
  for (const e of leaves) {
    const cs = getComputedStyle(e)
    const text = textOf(e)
    const own = ownText(e)
    const r = e.getBoundingClientRect()
    const t = textRect(e)
    if (t.width === 0 || t.height === 0) {
      continue
    }
    const inline = cs.display === 'inline' || cs.display === 'contents'
    if (!inline) {
      const bl = Number.parseFloat(cs.borderLeftWidth) || 0
      const br = Number.parseFloat(cs.borderRightWidth) || 0
      const left = r.left + bl - t.left
      const right = t.right - (r.right - br)
      if (left > tol || right > tol) {
        out.push({
          kind: 'overflow',
          el: nameOf(e),
          text,
          detail: `text runs ${Math.round(Math.max(left, right))} px outside its box (${left > tol ? 'left' : 'right'}; box ${Math.round(r.width)} px)`,
        })
      }
      const truncX = cs.textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1
      const clamp = cs.getPropertyValue('-webkit-line-clamp')
      const truncY = clamp !== '' && clamp !== 'none' && e.scrollHeight > e.clientHeight + 1
      if (truncX || truncY) {
        out.push({
          kind: 'ellipsis',
          el: nameOf(e),
          text,
          detail: `${own.length <= a.shortText ? 'SHORT ' : ''}text truncated (${own.length} chars, ${truncX ? `${e.scrollWidth}/${e.clientWidth} px` : 'line clamp'})`,
        })
      }
    }
    const c = clipper(e)
    if (c && !c.scrolls) {
      const k = c.el.getBoundingClientRect()
      const ck = getComputedStyle(c.el)
      const kl = k.left + (Number.parseFloat(ck.borderLeftWidth) || 0)
      const kr = k.right - (Number.parseFloat(ck.borderRightWidth) || 0)
      const kt = k.top + (Number.parseFloat(ck.borderTopWidth) || 0)
      const kb = k.bottom - (Number.parseFloat(ck.borderBottomWidth) || 0)
      const over = Math.max(kl - t.left, t.right - kr, kt - t.top, t.bottom - kb)
      // text already reported as an ellipsis is clipped on purpose
      const ellipsed = cs.textOverflow === 'ellipsis'
      if (over > 2 && !ellipsed) {
        out.push({
          kind: 'clip',
          el: nameOf(e),
          text,
          detail: `text clipped ${Math.round(over)} px by ${nameOf(c.el)}`,
        })
      }
    }
    // a scroll hint (an edge-fading mask) on a strip that has nothing to scroll fades real text
    for (let p = e.parentElement; p; p = p.parentElement) {
      const pm = getComputedStyle(p)
      const mask = pm.maskImage || pm.getPropertyValue('-webkit-mask-image')
      if (mask && mask !== 'none' && mask.includes('gradient')) {
        const k = p.getBoundingClientRect()
        const fits = p.scrollWidth <= p.clientWidth + 1
        if (fits && t.right > k.right - k.width * 0.15) {
          out.push({
            kind: 'clip',
            el: nameOf(e),
            text,
            detail: `text faded by ${nameOf(p)}'s edge mask, though nothing scrolls`,
          })
        } else if (!fits && p.children.length <= 3 && t.right > k.right + 1) {
          // a long tab strip scrolls on purpose; two or three tabs are meant to fit
          out.push({
            kind: 'clip',
            el: nameOf(e),
            text,
            detail: `text cut at the edge of ${nameOf(p)} (${p.children.length} items should fit)`,
          })
        }
        break
      }
    }
    if (!c?.scrolls) {
      const over = Math.max(-t.left, t.right - innerWidth, -t.top, t.bottom - innerHeight)
      if (over > 2) {
        out.push({
          kind: 'clip',
          el: nameOf(e),
          text,
          detail: `text ${Math.round(over)} px off screen`,
        })
      }
    }
  }
  // a word broken across lines (overflow-wrap: anywhere as a fallback is fine for a 16-letter
  // name; a dictionary word split in two means the type should have shrunk)
  for (const e of leaves) {
    for (const n of e.childNodes) {
      if (n.nodeType !== Node.TEXT_NODE) {
        continue
      }
      const str = n.textContent ?? ''
      // a hyphen is a fair place to break: "Six-Shooter" is two words here
      for (const m of str.matchAll(/[^\s\-‐–—]+/gu)) {
        const word = m[0]
        if (word.length < 3 || word.length > 12) {
          continue
        }
        range.setStart(n, m.index)
        range.setEnd(n, m.index + word.length)
        const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)))
        if (tops.size > 1) {
          out.push({
            kind: 'break',
            el: nameOf(e),
            text: textOf(e),
            detail: `“${word}” is split across lines`,
          })
        }
      }
    }
  }
  // overlap: own text lines of different elements, cut to what their clipping ancestors show
  const shown = (e: Element, r: DOMRect): DOMRect | null => {
    let { left, top, right, bottom } = r
    for (let p = e.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') {
        continue
      }
      const k = p.getBoundingClientRect()
      left = Math.max(left, k.left)
      top = Math.max(top, k.top)
      right = Math.min(right, k.right)
      bottom = Math.min(bottom, k.bottom)
    }
    return right - left > 1 && bottom - top > 1
      ? new DOMRect(left, top, right - left, bottom - top)
      : null
  }
  const lines: { e: HTMLElement; r: DOMRect }[] = []
  for (const e of leaves) {
    for (const n of e.childNodes) {
      if (n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? '').trim()) {
        continue
      }
      range.selectNodeContents(n)
      for (const line of range.getClientRects()) {
        const r = shown(e, line)
        if (r) {
          lines.push({ e, r })
        }
      }
    }
  }
  const seen = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const p = lines[i]
      const q = lines[j]
      if (!(p && q) || p.e === q.e) {
        continue
      }
      const w = Math.min(p.r.right, q.r.right) - Math.max(p.r.left, q.r.left)
      // glyph boxes include the line's leading: trim a little top and bottom
      const pad = Math.min(p.r.height, q.r.height) * 0.18
      const h = Math.min(p.r.bottom, q.r.bottom) - Math.max(p.r.top, q.r.top) - 2 * pad
      if (w > 2 && h > 2) {
        const key = `${nameOf(p.e)}|${nameOf(q.e)}|${textOf(p.e)}|${textOf(q.e)}`
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            kind: 'overlap',
            el: `${nameOf(p.e)} × ${nameOf(q.e)}`,
            text: `${textOf(p.e).slice(0, 28)} × ${textOf(q.e).slice(0, 28)}`,
            detail: `text lines overlap ${Math.round(w)}×${Math.round(h)} px`,
          })
        }
      }
    }
  }
  // tap targets and fonts
  const interactive =
    'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="link"]'
  for (const e of els) {
    if (!e.matches(interactive)) {
      continue
    }
    // a control inside a label: the label is the target
    const label = e.closest('label')
    const target = e.matches('input') && label ? label : e
    const r = target.getBoundingClientRect()
    const cs = getComputedStyle(e)
    // inline links in running text are exempt (WCAG 2.5.8)
    const inlineLink =
      e.matches('a') &&
      cs.display === 'inline' &&
      (e.parentElement?.textContent ?? '').trim().length > (e.textContent ?? '').trim().length + 12
    if (!inlineLink && (r.width < a.tap - 0.5 || r.height < a.tap - 0.5)) {
      out.push({
        kind: 'tap',
        el: nameOf(target),
        text: textOf(target) || (e.getAttribute('aria-label') ?? ''),
        detail: `${Math.round(r.width)}×${Math.round(r.height)} px (< ${a.tap})`,
      })
    }
    const first = (cs.fontFamily.split(',')[0] ?? '').trim().replace(/^["']|["']$/gu, '')
    // checkboxes and radios draw no text
    const hasText =
      (e.textContent ?? '').trim().length > 0 ||
      e.matches('input:not([type="checkbox"], [type="radio"], [type="range"]), select, textarea')
    if (hasText && !a.fonts.includes(first)) {
      out.push({
        kind: 'font',
        el: nameOf(e),
        text: textOf(e),
        detail: `font-family starts with "${first}"`,
      })
    }
  }
  // a heading row (a title and its buttons): the buttons must stay on the title's line
  for (const row of els) {
    const cs = getComputedStyle(row)
    if (!(cs.display.endsWith('flex') && cs.flexDirection === 'row')) {
      continue
    }
    const kids = [...row.children].filter((k) => els.includes(k as HTMLElement))
    const head = kids.find((k) => ['H1', 'H2', 'H3'].includes(k.tagName))
    if (!head) {
      continue
    }
    const h = head.getBoundingClientRect()
    for (const k of kids) {
      if (k.matches('button, [role="button"]') && k.getBoundingClientRect().top >= h.bottom - 1) {
        out.push({
          kind: 'wrap',
          el: `${nameOf(head)} + ${nameOf(k)}`,
          text: `${textOf(head)} + ${textOf(k)}`,
          detail: 'the button wrapped under its heading',
        })
      }
    }
  }
  if (a.deadPrimary) {
    for (const e of els) {
      if (e.matches(`${a.deadPrimary} .ow-btn-primary:disabled`)) {
        out.push({
          kind: 'state',
          el: nameOf(e),
          text: textOf(e),
          detail: 'a disabled primary action is still shown (hide it when it cannot happen)',
        })
      }
    }
  }
  return out
}
