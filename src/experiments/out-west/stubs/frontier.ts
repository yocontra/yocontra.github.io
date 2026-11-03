/**
 * TEMPORARY PLACEHOLDER (stream D) for stream G's Frontier entry point in `ffa/client/`.
 * The hub calls `mountFrontier(root, { onExit })`; swap the import in `ui/hub.ts` when G lands.
 */
export function mountFrontier(
  root: HTMLElement,
  opts: { onExit: () => void },
): { dispose: () => void } {
  const el = document.createElement('div')
  el.className = 'ow-hub-sheet on'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', 'Frontier')
  const panel = document.createElement('div')
  panel.className = 'ow-hub-panel'
  const h = document.createElement('h2')
  h.className = 'ow-hub-h'
  h.textContent = 'Frontier'
  const p = document.createElement('p')
  p.className = 'ow-hub-note'
  p.textContent =
    'The town of Perdition is still being built. Thirty-two guns, one bank, no law. Ride back soon.'
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'ow-btn ow-btn-primary'
  back.textContent = 'Back to the saloon'
  const dispose = (): void => el.remove()
  back.addEventListener('click', () => {
    dispose()
    opts.onExit()
  })
  panel.append(h, p, back)
  el.append(panel)
  root.append(el)
  return { dispose }
}
