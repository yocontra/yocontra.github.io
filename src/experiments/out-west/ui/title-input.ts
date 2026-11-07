/** Title activation stays separate from links, dialogs and focused controls. */
const START_KEYS = new Set(['Space', 'Enter', 'KeyJ', 'KeyW', 'ArrowUp', 'ArrowLeft'])
const CONTROL = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  '[contenteditable]',
  '[role=dialog]',
].join(', ')

/** Returns an idempotent cleanup; the title relinquishes every listener after starting. */
export function installTitleInput(
  title: HTMLElement,
  start: HTMLElement,
  begin: () => void,
): () => void {
  const events = new AbortController()
  const options = { signal: events.signal }
  const activate = () => {
    events.abort()
    begin()
  }
  title.addEventListener(
    'click',
    (event) => {
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }
      if (target.closest(CONTROL) && !start.contains(target)) {
        return
      }
      activate()
    },
    options,
  )
  globalThis.addEventListener(
    'keydown',
    (event) => {
      if (
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !START_KEYS.has(event.code)
      ) {
        return
      }
      const target = event.target
      // Native buttons own Enter/Space. In particular, a focused Credits/Leaderboard button must
      // activate that control, and text fields in a sheet must retain their editing shortcuts.
      if (target instanceof Element && target.closest(CONTROL)) {
        return
      }
      if (title.querySelector('.ow-credits.on') || document.querySelector('.ow-sheet.on')) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      activate()
    },
    options,
  )
  return () => events.abort()
}
