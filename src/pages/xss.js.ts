import type { APIRoute } from 'astro'

// Legacy payload kept at /xss.js for anything still pointing at it.
export const GET: APIRoute = () =>
  new Response("alert('XSS1');\n", {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
  })
