import type { APIRoute } from 'astro'

// Legacy payload kept at /xss.js for anything still pointing at it.
// biome-ignore lint/security/noSecrets: an intentional legacy test payload, not a credential
const PAYLOAD = "alert('XSS1');\n"

export const GET: APIRoute = () =>
  new Response(PAYLOAD, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
  })
