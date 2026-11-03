import sitemap from '@astrojs/sitemap'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://contra.io',
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
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
