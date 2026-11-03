/**
 * Bun preload for the Apparish generators, whose entry scripts test a bare `ELEVENLABS_API_KEY`
 * global that nothing declares. This exposes it as a lazy getter over `process.env` (filled by the
 * script's own dotenv call), so the key is read only by the generator, never logged or copied here.
 */
Object.defineProperty(globalThis, 'ELEVENLABS_API_KEY', {
  configurable: true,
  get: () => process.env.ELEVENLABS_API_KEY,
})
