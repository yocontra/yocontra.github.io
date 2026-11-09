import { expect, test as it } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { spawn, write } from 'bun'
import { COLLISION_VERSION } from '../../src/experiments/out-west/content/manifest.ts'
import { PROTOCOL_VERSION } from '../../src/experiments/out-west/runtime/protocol.ts'

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
    throw new Error(`${stdout}\n${stderr}`)
  }
  return stdout
}

it('native SDK voice controls are lazy and failed teardown survives real cold DO alarms without gameplay boot', async () => {
  const root = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'out-west-voice-workerd-'))
  try {
    const config = join(directory, 'wrangler.jsonc')
    const output = join(directory, 'bundle')
    await write(
      config,
      JSON.stringify({
        name: 'voice-runtime-test',
        main: join(root, 'api/test/voice-worker.ts'),
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
    const entry = await readFile(join(output, 'voice-worker.js'), 'utf8')
    const wasm = (await readdir(output)).filter((name) => name.endsWith('.wasm'))
    const script = `
import {Miniflare,convertV4MiniflareOptions} from ${JSON.stringify(join(root, 'node_modules/miniflare/dist/src/index.js'))};
import fs from 'node:fs';
delete globalThis.WebSocket;
const {Client}=await import(${JSON.stringify(join(root, 'node_modules/@colyseus/sdk/build/index.mjs'))});
const modules=${JSON.stringify(wasm)}.map(name=>({type:'CompiledWasm',path:${JSON.stringify(root)}+'/'+name,contents:fs.readFileSync(${JSON.stringify(output)}+'/'+name)}));
modules.unshift({type:'ESModule',path:${JSON.stringify(join(root, 'voice-worker.js'))},contents:${JSON.stringify(entry)}});
let failKick=false,serial=0;const calls=[],tokens=new Set();
const objects=Object.fromEntries(Object.entries({DUELS:'DuelSession',MATCHMAKER:'Matchmaker',DUEL_ROOMS:'DuelRoom',LOBBY_DIR:'LobbyDirectory',LOBBIES:'Lobby',DAILY_SESSIONS:'DailySession',SETTLEMENT:'SettlementProbe'}).map(([key,className])=>[key,{className,useSQLite:true}]));
const mf=new Miniflare(convertV4MiniflareOptions({modules,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],durableObjects:objects,d1Databases:{DB:'voice-fixture'},bindings:{AUTH_SECRET:'voice-fixture-secret',ALLOWED_ORIGINS:'http://127.0.0.1:4390',RP_ID:'localhost',TURNSTILE_SECRET:'fixture-only',CLOUDFLARE_ACCOUNT_ID:'fixture',REALTIMEKIT_APP_ID:'fixture',REALTIMEKIT_API_TOKEN:'fixture-only',REALTIMEKIT_PRESET:'voice'},outboundService:async request=>{
 if(request.url.startsWith('https://challenges.cloudflare.com/'))return Response.json({success:true});
 if(!request.url.startsWith('https://api.cloudflare.com/'))throw new Error('Unexpected external request');
 const path=new URL(request.url).pathname;calls.push({path,method:request.method});
 if(failKick&&path.endsWith('/kick-all'))return Response.json({success:false},{status:500});
 if(path.endsWith('/meetings'))return Response.json({success:true,data:{id:'fixture-meeting-'+(++serial)}});
 if(path.endsWith('/participants')&&request.method==='POST'){const id='fixture-participant-'+(++serial);tokens.add(id);return Response.json({success:true,data:{id,token:'nonbillable-fixture-token'}})}
 if(request.method==='DELETE')tokens.delete(path.split('/').at(-1));
 return Response.json({success:true,data:{}});
}}));
const rooms=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(test,label)=>{for(let i=0;i<100;i++){if(await test())return;await sleep(50)}throw new Error('Timed out: '+label)};
try{
 const base=(await mf.ready).origin,db=await mf.getD1Database('DB');
 for(const name of fs.readdirSync(${JSON.stringify(join(root, 'api/migrations'))}).filter(n=>n.endsWith('.sql')).sort()){
  const statements=fs.readFileSync(${JSON.stringify(join(root, 'api/migrations'))}+'/'+name,'utf8').replace(/^\\s*--.*$/gmu,'').split(/;\\s*$/mu).map(x=>x.trim()).filter(Boolean);await db.batch(statements.map(sql=>db.prepare(sql)));
 }
 let lobbyId='';const controls=[[],[]];
 for(let i=0;i<2;i++){
  const account=await(await fetch(base+'/__test/seed')).json();
  const response=await fetch(base+'/town/join',{method:'POST',headers:{Origin:'http://127.0.0.1:4390',Authorization:'Bearer '+account.token,'Content-Type':'application/json'},body:JSON.stringify({wire:10,protocol:${PROTOCOL_VERSION},collision:${JSON.stringify(COLLISION_VERSION)},turnstileToken:'fixture-only',...(lobbyId?{lobbyId}:{})})});
  const admission=await response.json();if(response.status!==201)throw new Error(JSON.stringify(admission));
  lobbyId=admission.lobbyId;
  const room=await new Client(base+'/town/'+lobbyId+'?'+new URL(admission.wsUrl).searchParams.toString(),{headers:{Origin:'http://127.0.0.1:4390'}}).consumeSeatReservation(admission.reservation);room.reconnection.enabled=false;rooms.push(room);
  room.onMessage('control',m=>controls[i].push(m));room.onMessage('events',()=>{});room.onMessage('network-ping',m=>room.send('network-pong',{nonce:m.nonce}));
 }
 const endpoint=path=>base+path+'?lobbyId='+encodeURIComponent(lobbyId);
 const observe=async()=>await(await fetch(endpoint('/__voice/observe'))).json();
 await fetch(endpoint('/__voice/place'));
 rooms[0].send('control',{type:'voice_on'});
 rooms[0].send('control',{type:'voice_talk',talking:true});
 await sleep(100);if(calls.length)throw new Error('Alone voice allocated provider resources');
 rooms[0].send('control',{type:'voice_talk',talking:false});
 rooms[1].send('control',{type:'voice_on'});

 await until(()=>controls.every(list=>list.some(m=>m.type==='voice_status'&&m.listeners===1)),'unsolicited status');
 if(calls.length)throw new Error('Idle audience joined RTK');
 rooms[0].send('control',{type:'voice_talk',talking:true});
 await until(()=>controls.every(list=>list.some(m=>m.type==='voice_ready'&&Number.isInteger(m.generation))),'two unsolicited credentials');
 if(tokens.size!==2)throw new Error('Two actual humans were not admitted');
 rooms[0].send('control',{type:'voice_talk',talking:false});
 await until(()=>tokens.size===0,'silence teardown');
 await until(()=>controls.every(list=>list.some(m=>m.type==='voice_standby')),'standby routing');
 failKick=true;rooms[0].send('control',{type:'voice_talk',talking:true});
 await until(()=>tokens.size===2,'second speech allocation');
 await Promise.all(rooms.splice(0).map(room=>room.leave(false)));await sleep(200);
 const warm=await observe();const timing=await(await fetch(endpoint('/__test/native-timing'))).json();
 if(warm.resources.timers||warm.resources.members||!warm.resources.cleanup||timing.active||timing.core||timing.physics||timing.running||timing.timer)throw new Error('Last human retained live voice/game work '+JSON.stringify({warm,timing}));
 try{await fetch(endpoint('/__test/restart-native'))}catch{}
 const cold=await observe();const creates=calls.filter(c=>c.path.endsWith('/meetings')).length;failKick=false;
 await until(async()=> (await observe()).resources.cleanup===0,'cold alarm retry');
 const settled=await(await fetch(endpoint('/__test/native-timing'))).json();
 if(tokens.size||settled.active||settled.core||settled.physics||settled.running||settled.timer||calls.filter(c=>c.path.endsWith('/meetings')).length!==creates)throw new Error('Cold cleanup booted game or retained tokens');
 failKick=true;const duel=await(await fetch(base+'/__voice/duel?duel=1')).json();
 if(duel.early.flow||duel.early.closed||duel.early.deadline!==duel.deadline)throw new Error('Early voice alarm expired duel');
 let closed=await(await fetch(base+'/__voice/observe?duel=1')).json();
 await until(async()=>{closed=await(await fetch(base+'/__voice/observe?duel=1')).json();return !closed.keys.includes('stored')&&!closed.keys.includes('rest')},'closed game metadata retirement');
 if(!closed.keys.includes('voice')||!closed.keys.includes('closed')||closed.flow||closed.pings)throw new Error('Closed duel lost durable voice ledger or retained gameplay');
 try{await fetch(base+'/__voice/restart?duel=1')}catch{}
 failKick=false;await until(async()=>{const c=await(await fetch(base+'/__voice/observe?duel=1')).json();return c.resources.cleanup===0&&!c.flow&&!c.pings},'closed duel cold cleanup');
 await db.prepare("DELETE FROM usage WHERE metric='voice_reserved_seconds'").run();
 const ceiling=9000*60,now=Date.parse('2026-12-01T00:00:00.000Z');
 await db.prepare("INSERT INTO usage(month,metric,amount) VALUES('voice:2026-11-30','voice_reserved_seconds',?)").bind(ceiling-60).run();
 const claims=await Promise.all(Array.from({length:8},(_,i)=>fetch(base+'/__voice/budget?count=1&now='+(now+(i%2?-1:0))).then(r=>r.json())));
 if(claims.filter(c=>c.allowed).length!==1)throw new Error('Concurrent midnight claims exceeded rolling cap: '+JSON.stringify(claims));
 const reserved=await db.prepare("SELECT SUM(amount) AS amount FROM usage WHERE metric='voice_reserved_seconds'").first();
 if(reserved.amount!==ceiling)throw new Error('Reservation aggregate exceeded cap');
 const expired=await(await fetch(base+'/__voice/budget?count=1&now='+Date.parse('2027-01-03T00:00:00.000Z'))).json();
 if(!expired.allowed)throw new Error('Old conservative reservations never expired');
 console.log('RESULT:'+JSON.stringify({controls:controls.map(list=>list.filter(m=>m.type.startsWith('voice_')).map(m=>m.type)),calls:calls.length,cold,settled,tokens:tokens.size,duel:closed.keys,budget:{claims:claims.filter(c=>c.allowed).length,reserved:reserved.amount,expired:expired.allowed}}));
}finally{await Promise.all(rooms.map(room=>room.leave(false).catch(()=>{})));await mf.dispose()}
`
    const runner = join(directory, 'voice-runtime.mjs')
    await write(runner, script)
    const result = await execute(['node', runner])
    const line = result.split('\n').find((value) => value.startsWith('RESULT:'))
    expect(line).toBeDefined()
    await write('/tmp/out-west-voice-workerd-result.json', line?.slice(7) ?? '{}')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 45_000)
