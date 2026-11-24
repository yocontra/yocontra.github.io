/** Bundle a Worker and leave its WebAssembly imports for workerd to compile. */
import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, dirname, resolve } from 'node:path'
import { type Plugin, rolldown } from 'rolldown'

export async function buildWorker(
  entry: string,
  directory: string,
  plugins: Plugin[] = [],
): Promise<void> {
  const bundle = await rolldown({
    input: resolve(entry),
    platform: 'node',
    // Colyseus probes this optional package for its standalone PM2 process metrics.
    external: ['@pm2/io'],
    resolve: { conditionNames: ['workerd', 'worker', 'browser'], mainFields: ['module', 'main'] },
    plugins: [
      ...plugins,
      {
        name: 'workerd-modules',
        async resolveId(source, importer) {
          if (isBuiltin(source) || source.startsWith('cloudflare:')) {
            const id = isBuiltin(source) && !source.startsWith('node:') ? `node:${source}` : source
            return { id, external: true }
          }
          if (importer && source.endsWith('.wasm')) {
            const path = resolve(dirname(importer), source)
            const fileName = basename(path)
            this.emitFile({ type: 'asset', fileName, source: await readFile(path) })
            return { id: `./${fileName}`, external: true }
          }
          return null
        },
      },
    ],
  })
  try {
    await bundle.write({
      dir: resolve(directory),
      format: 'esm',
      codeSplitting: false,
      // workerd has no import.meta.url. Its Node compatibility layer accepts a fixed file URL.
      polyfillRequire: false,
      banner:
        "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire('file:///worker.js');",
    })
  } finally {
    await bundle.close()
  }
}

if (import.meta.main) {
  const [entry = 'api/src/index.ts', directory = 'api/.wrangler/worker'] = process.argv.slice(2)
  await buildWorker(entry, directory)
}
