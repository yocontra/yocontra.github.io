import { expect, test as it } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { spawn, write } from 'bun'

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

it('Wrangler bundle sends autonomous Colyseus state to quiet clients in isolated Durable Objects', async () => {
  const root = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'out-west-colyseus-'))
  try {
    const config = join(directory, 'wrangler.jsonc')
    const output = join(directory, 'bundle')
    await write(
      config,
      JSON.stringify({
        name: 'out-west-runtime-test',
        main: join(root, 'api/test/colyseus-worker.ts'),
        compatibility_date: '2026-10-01',
        compatibility_flags: ['nodejs_compat'],
      }),
    )
    await execute([
      'node',
      join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'deploy',
      '--dry-run',
      '--config',
      config,
      '--outdir',
      output,
    ])
    const moduleFiles = (await readdir(output)).filter((name) => name.endsWith('.wasm'))
    expect(moduleFiles).toHaveLength(2)
    const entry = await readFile(join(output, 'colyseus-worker.js'), 'utf8')
    // Module identities stay inside the configured root. No source transforms or runtime shims.
    const script = `
  import {Miniflare,convertV4MiniflareOptions} from ${JSON.stringify(join(root, 'node_modules/miniflare/dist/src/index.js'))};
  import {Client} from ${JSON.stringify(join(root, 'node_modules/@colyseus/sdk/build/index.mjs'))};
  import fs from 'node:fs';
  const deadline=setTimeout(()=>{console.error('Native room timed out');process.exit(1)},25000);deadline.unref();
  const modules=${JSON.stringify(moduleFiles)}.map(name=>({type:'CompiledWasm',path:${JSON.stringify(root)}+'/'+name,contents:fs.readFileSync(${JSON.stringify(output)}+'/'+name)}));
  modules.unshift({type:'ESModule',path:${JSON.stringify(join(root, 'worker.js'))},contents:${JSON.stringify(entry)}});
  const mf=new Miniflare(convertV4MiniflareOptions({modules,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOMS:{className:'TestRoom',useSQLite:true}}}));
  const rooms=[];
  try{
   const base=(await mf.ready).origin;
   const seats=[];
   for(const [account,which]of [['alice','first'],['bob','first'],['carol','second']]){
    const reservation=await(await fetch(base+'/reserve?account='+account+'&room='+which)).json();
    seats.push({account,reservation});
   }
   rooms.push(...await Promise.all(seats.map(async({account,reservation})=>{
    const room=await new Client(base+'?account='+account).consumeSeatReservation(reservation);
    room.onMessage('control',()=>{});room.onMessage('events',()=>{});room.onMessage('network-ping',message=>room.send('network-pong',{nonce:message.nonce}));return room;
   })));
   await new Promise(resolve=>setTimeout(resolve,1000));
   const before=rooms.map(room=>room.state.tick);
   await new Promise(resolve=>setTimeout(resolve,3000));
   const after=rooms.map(room=>({tick:room.state.tick,players:room.state.players.size,own:[...room.state.players.values()].some(player=>player.sessionId===room.sessionId)}));
   const currentInput=rooms[0].input({mode:'reliable'});Object.assign(currentInput.data,{seq:42,moveX:.5,moveZ:0,yaw:0,pitch:0,buttons:0,viewTime:0});currentInput.send();
   await new Promise(resolve=>setTimeout(resolve,150));
   if(![...rooms[0].state.players.values()].some(player=>player.sessionId===rooms[0].sessionId&&player.seq===42))throw new Error('Current SDK input stopped working');
   await rooms[0].leave();await rooms[1].leave();await new Promise(resolve=>setTimeout(resolve,500));
   console.log('RESULT:'+JSON.stringify({before,after,otherContinued:rooms[2].state.tick>after[2].tick}));
   await rooms[2].leave();
   const bindings=await(await fetch(base+'/bindings?room=binding-probe')).json();
   if(!bindings.reusedSlot||!bindings.sameSessionProtected||!bindings.retired)throw new Error('Connection binding regression: '+JSON.stringify(bindings));
   const now=Date.UTC(2026,10,7,12);
   const lease=async(id,messages=0,finish=false,time=now)=>await(await fetch(base+'/lease?room=admission',{method:'POST',body:JSON.stringify({id,messages,finish,now:time})})).json();
   const grants=await Promise.all(Array.from({length:40},(_,i)=>lease('concurrent-'+i)));
   const granted=grants.map((grant,i)=>grant.ok?i:null).filter(i=>i!==null);
   const expired=await lease('after-expiry',0,false,now+90000);
   await lease('concurrent-'+granted[0],0,true,now+90000);
   const released=await lease('after-release',0,false,now+90000);
   const rollover=await lease('new-day',0,false,now+86400000);
   console.log('LEASES:'+JSON.stringify({accepted:granted.length,expired:expired.ok,released:released.ok,rollover:rollover.ok}));
  }finally{clearTimeout(deadline);await mf.dispose()}
  `
    const stdout = await execute(['node', '--input-type=module'], script)
    const line = stdout.split('\n').find((value) => value.startsWith('RESULT:'))
    if (!line) {
      throw new Error(stdout)
    }
    const result = JSON.parse(line.slice(7)) as {
      before: number[]
      after: { tick: number; players: number; own: boolean }[]
      otherContinued: boolean
    }
    expect(result.after.map((value) => value.players)).toEqual([2, 2, 1])
    expect(result.after.every((value) => value.own)).toBe(true)
    expect(
      result.after.every((value, index) => value.tick - (result.before[index] ?? 0) > 40),
    ).toBe(true)
    expect(result.otherContinued).toBe(true)
    const leases = stdout.split('\n').find((value) => value.startsWith('LEASES:'))
    expect(leases).toBeDefined()
    expect(JSON.parse(leases?.slice(7) ?? '{}')).toEqual({
      accepted: 31,
      expired: false,
      released: true,
      rollover: true,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
