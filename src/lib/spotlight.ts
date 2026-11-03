/** Tracks the pointer inside each element as --mx / --my for a CSS radial-gradient spotlight. */
export function spotlight(elements: NodeListOf<HTMLElement>): void {
  for (const el of elements) {
    el.addEventListener(
      'pointermove',
      (event) => {
        const rect = el.getBoundingClientRect()
        el.style.setProperty('--mx', `${event.clientX - rect.left}px`)
        el.style.setProperty('--my', `${event.clientY - rect.top}px`)
      },
      { passive: true },
    )
  }
}
