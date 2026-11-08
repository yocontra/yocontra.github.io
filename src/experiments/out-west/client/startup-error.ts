/** A download, stale bundle or decoder failure is not evidence that the GPU lacks WebGL2. */
export function startupFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (
    message.includes('GraphicsDevice') ||
    message.includes('WebGL') ||
    message.includes('graphics device')
  ) {
    return 'Could not start 3D graphics. Try reloading, or play the 2019 original below.'
  }
  return 'Could not load the town. Check your connection and try again.'
}
