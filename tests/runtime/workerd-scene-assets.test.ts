import { expect, test as it } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { spawn } from 'bun'
import { SCENE_ASSETS, sceneKey } from '../../api/src/assets/scene-assets.ts'
import { hangTimeout } from '../timeout.ts'

async function execute(args: string[], source?: string) {
  const child = spawn(args, {
    stdin: source === undefined ? 'ignore' : new Blob([source]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) {
    throw new Error(`${args.join(' ')}\n${stdout}\n${stderr}`)
  }
  return stdout
}

it(
  'production scene routes use real local R2, ranges/cache and no API/provider bindings',
  async () => {
    const root = process.cwd()
    const directory = await mkdtemp(join(tmpdir(), 'out-west-r2-scenes-'))
    try {
      await execute([
        'node',
        join(root, 'node_modules/wrangler/bin/wrangler.js'),
        'deploy',
        '--dry-run',
        '--config',
        join(root, 'api/wrangler.jsonc'),
        '--outdir',
        directory,
      ])
      const entry = await readFile(join(directory, 'index.js'), 'utf8')
      const wasm = (await readdir(directory)).filter((name) => name.endsWith('.wasm'))
      const assets = SCENE_ASSETS.map((asset) => ({
        ...asset,
        key: sceneKey(asset.path, asset.hash.slice(0, 16)),
      }))
      const script = `
import {Miniflare,convertV4MiniflareOptions} from ${JSON.stringify(join(root, 'node_modules/miniflare/dist/src/index.js'))};
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const assets=${JSON.stringify(assets)};
const modules=${JSON.stringify(wasm)}.map(name=>({type:'CompiledWasm',path:${JSON.stringify(root)}+'/'+name,contents:fs.readFileSync(${JSON.stringify(directory)}+'/'+name)}));
modules.unshift({type:'ESModule',path:${JSON.stringify(join(root, 'index.js'))},contents:${JSON.stringify(entry)}});
let outbound=0;
const options={modules,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],bindings:{ALLOWED_ORIGINS:'https://contra.io'},outboundService:()=>{outbound++;throw Error('Unexpected provider/origin call')}};
const mf=new Miniflare(convertV4MiniflareOptions({...options,r2Buckets:{SCENES:'local-scenes'}}));
const absent=new Miniflare(convertV4MiniflareOptions(options));
let assertions=0;const eq=(actual,expected)=>{assert.equal(actual,expected);assertions++};
const request=(path,init)=>mf.dispatchFetch('https://contra.io'+path,init);
try{
 const bucket=await mf.getR2Bucket('SCENES');
 for(const asset of assets)await bucket.put(asset.key,fs.readFileSync(${JSON.stringify(join(root, 'public'))}+asset.path));
 for(const asset of assets){const head=await request(asset.url,{method:'HEAD'});eq(head.status,200);eq(head.headers.get('Content-Length'),String(asset.bytes));eq(await head.text(),'');eq(head.headers.get('Content-Type'),'model/gltf-binary')}
 const asset=assets[0],bytes=fs.readFileSync(${JSON.stringify(join(root, 'public'))}+asset.path);
 const part=await request(asset.url,{headers:{Range:'bytes=0-7'}});eq(part.status,206);eq(Buffer.from(await part.arrayBuffer()).toString('hex'),bytes.subarray(0,8).toString('hex'));eq(part.headers.get('Content-Range'),'bytes 0-7/'+asset.bytes);
 const etag=part.headers.get('ETag');eq((await request(asset.url,{headers:{'If-None-Match':etag}})).status,304);
 const tail=await request(asset.url,{headers:{Range:'bytes=-4'}});eq(tail.status,206);eq(Buffer.from(await tail.arrayBuffer()).toString('hex'),bytes.subarray(-4).toString('hex'));
 for(const range of ['bytes=999999999-','bytes=5-2','bytes=0-1,5-6','bytes=-0','garbage'])eq((await request(asset.url,{headers:{Range:range}})).status,416);
 for(const method of ['POST','OPTIONS','DELETE'])eq((await request(asset.url,{method})).status,405);
 for(const query of ['?v=../../secret','?v=https://evil.invalid','?v=BAD','?v=','?v=aaaaaaaaaaaaaaaa&v=bbbbbbbbbbbbbbbb'])eq((await request(asset.path+query)).status,400);
 eq((await request(asset.path+'/secret')).status,404);eq((await request(asset.path.replace('frontier-detail.glb','private.glb'))).status,404);eq((await mf.dispatchFetch('https://api.contra.io'+asset.url)).status,404);
 const fallback=await request(asset.path+'?v=aaaaaaaaaaaaaaaa',{method:'HEAD'});eq(fallback.status,200);eq(fallback.headers.get('Cache-Control'),'public, max-age=300');
 const old='0123456789abcdef';await bucket.put(sceneKeyPlaceholder(asset.path,old),new Uint8Array([1,2,3]));
 const historic=await request(asset.path+'?v='+old);eq(historic.status,200);eq(Buffer.from(await historic.arrayBuffer()).toString('hex'),'010203');eq(historic.headers.get('Cache-Control'),'public, max-age=31536000, immutable');
 const full=await request(asset.url);eq(full.status,200);eq(createHash('sha256').update(Buffer.from(await full.arrayBuffer())).digest('hex'),asset.hash);
 await new Promise(resolve=>setTimeout(resolve,100));
 const unversioned=await request(asset.path);eq(unversioned.status,200);eq(unversioned.headers.get('Cache-Control'),'public, max-age=300');await unversioned.body.cancel();
 eq((await request(asset.url,{headers:{'If-None-Match':'W/'+etag}})).status,304);
 eq((await absent.dispatchFetch('https://contra.io'+asset.url)).status,503);
 const corrupt=assets[1];await bucket.put(corrupt.key,new Uint8Array([0]));eq((await request(corrupt.url,{method:'HEAD'})).status,502);
 const missing=assets[2];await bucket.delete(missing.key);eq((await request(missing.url,{method:'HEAD'})).status,404);
 eq(outbound,0);console.log('RESULT:'+JSON.stringify({assertions,assets:assets.length,outbound}));
}finally{await mf.dispose();await absent.dispose()}
function sceneKeyPlaceholder(path,version){return path.slice(path.lastIndexOf('/')+1)+'/'+version}
`
      const runner = join(directory, 'run.mjs')
      await writeFile(runner, script)
      const stdout = await execute(['node', runner])
      const line = stdout.split('\n').find((value) => value.startsWith('RESULT:'))
      if (!line) {
        throw new Error(stdout)
      }
      const result = JSON.parse(line.slice(7)) as {
        assertions: number
        assets: number
        outbound: number
      }
      expect(result.assertions).toBeGreaterThan(50)
      expect(result.assets).toBe(5)
      expect(result.outbound).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  hangTimeout(60_000),
)
