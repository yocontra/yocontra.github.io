/** Start with the project's installed Vite CLI, then run tools/test-playcanvas-voice.ts. */
export default {
  root: process.cwd(),
  publicDir: false,
  server: { host: '127.0.0.1', port: 4398, strictPort: true, hmr: false },
  optimizeDeps: { noDiscovery: true, include: ['@cloudflare/realtimekit'] },
  plugins: [
    {
      name: 'nonbillable-voice-transport',
      enforce: 'pre',
      transform(source: string, id: string) {
        return id.endsWith('/out-west/voice/transport.ts')
          ? source.replaceAll(
              "from './meeting.ts'",
              "from '/tools/content/voice-meeting-fixture.ts'",
            )
          : undefined
      },
    },
  ],
}
