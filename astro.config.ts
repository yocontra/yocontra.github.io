import process from 'node:process'
import sitemap from '@astrojs/sitemap'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://contra.io',
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
  // The perf harness's build (tools/frontier-perf.ts --prod) keeps hidden source maps so its
  // profile names real functions; the deploy never sets PUBLIC_OW_PERF_HARNESS.
  vite: {
    build: { sourcemap: process.env.PUBLIC_OW_PERF_HARNESS === '1' ? 'hidden' : false },
  },
  prefetch: {
    prefetchAll: true,
    defaultStrategy: 'viewport',
  },
  integrations: [
    sitemap({
      // Dev tools, prank pages and app-only flows stay out of search.
      filter: (page) =>
        !['/out-west/auth/', '/out-west/delete/', '/experiments/hax/'].some((path) =>
          page.includes(path),
        ),
    }),
  ],
})
