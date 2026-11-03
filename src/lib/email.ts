/**
 * Bot-resistant email links. The markup only carries a reversed, base64-encoded address in
 * `data-m`; the real address and mailto: link are assembled here, in the browser.
 */
export function revealEmail(links: NodeListOf<HTMLAnchorElement>): void {
  for (const link of links) {
    const encoded = link.dataset.m
    if (!encoded) {
      continue
    }
    const address = [...atob(encoded)].reverse().join('')
    link.textContent = address
    link.href = `mailto:${address}`
  }
}
