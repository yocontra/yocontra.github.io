/** Format generated source and data with the same tools as the repository checks. */
export async function formatContent(paths: readonly string[]): Promise<void> {
  const typescript = paths.filter((path) => path.endsWith('.ts'))
  const data = paths.filter((path) => !path.endsWith('.ts'))
  const commands: string[][] = []
  if (typescript.length) {
    commands.push(['bun', 'node_modules/oxfmt/bin/oxfmt', '--write', ...typescript])
  }
  if (data.length) {
    commands.push(['bun', 'node_modules/@biomejs/biome/bin/biome', 'format', '--write', ...data])
  }
  const exits = await Promise.all(
    commands.map((command) => Bun.spawn(command, { stdout: 'ignore', stderr: 'inherit' }).exited),
  )
  if (exits.some((code) => code !== 0)) {
    throw new Error('Generated content could not be formatted')
  }
}
