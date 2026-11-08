/** Keep standalone asset regeneration consistent with the repository's pinned formatter. */
export async function formatContent(paths: readonly string[]): Promise<void> {
  const formatter = Bun.spawn(
    ['bun', 'node_modules/@biomejs/biome/bin/biome', 'format', '--write', ...paths],
    { stdout: 'ignore', stderr: 'inherit' },
  )
  if ((await formatter.exited) !== 0) {
    throw new Error('Generated content could not be formatted')
  }
}
