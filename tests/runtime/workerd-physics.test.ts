import { expect, test as it } from 'bun:test'
import { join } from 'node:path'
import process from 'node:process'
import { build, spawn } from 'bun'

/** Run Miniflare under Node: its undici dispatch requires the Node runtime. */
it('real workerd initializes native Ammo and steps independently owned worlds', async () => {
  const root = process.cwd()
  const result = await build({
    entrypoints: [join(root, 'api/test/physics-worker.ts')],
    target: 'browser',
    external: ['*.wasm'],
    minify: true,
  })
  if (!result.success) {
    throw new AggregateError(result.logs, 'Worker bundle failed')
  }
  const bundle = result.outputs[0]
  if (!bundle) {
    throw new Error('Worker bundle missing')
  }
  const contents = await bundle.text()
  const script = `
  import {Miniflare,convertV4MiniflareOptions} from ${JSON.stringify(join(root, 'node_modules/miniflare/dist/src/index.js'))};
  import fs from 'node:fs';
  const mf=new Miniflare(convertV4MiniflareOptions({modules:[
   {type:'ESModule',path:${JSON.stringify(join(root, 'api/test/physics-worker.js'))},contents:${JSON.stringify(contents)}},
   {type:'CompiledWasm',path:${JSON.stringify(join(root, 'public/experiments/out-west/physics/ammo.wasm.wasm'))},contents:fs.readFileSync(${JSON.stringify(join(root, 'public/experiments/out-west/physics/ammo.wasm.wasm'))})},
   {type:'CompiledWasm',path:${JSON.stringify(join(root, 'api/src/game/physics-callback.wasm'))},contents:fs.readFileSync(${JSON.stringify(join(root, 'api/src/game/physics-callback.wasm'))})}
  ],compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat']}));
  try{const r=await mf.dispatchFetch('http://localhost/');console.log('RESULT:'+JSON.stringify({status:r.status,body:await r.text()}))}finally{await mf.dispose()}
 `
  const child = spawn(['node', '--input-type=module'], {
    stdin: new Blob([script]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) {
    throw new Error(errors)
  }
  const line = output.split('\n').find((value) => value.startsWith('RESULT:'))
  if (!line) {
    throw new Error(output)
  }
  const response = JSON.parse(line.slice(7)) as { status: number; body: string }
  expect(response.status).toBe(200)
  const state = JSON.parse(response.body) as {
    one: { x: number; y: number; grounded: boolean }
    two: { x: number; y: number; grounded: boolean }
  }
  expect(state.one.y).toBeCloseTo(0.9, 2)
  expect(state.two.y).toBeCloseTo(0.9, 2)
  expect(state.one.grounded).toBe(true)
  expect(state.two.grounded).toBe(true)
  expect(state.one.x).toBeCloseTo(0, 2)
  expect(state.two.x).toBeCloseTo(4, 2)
}, 30_000)
