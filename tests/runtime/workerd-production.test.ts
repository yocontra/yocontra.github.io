import { expect, test as it } from 'bun:test'
import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { build, spawn, write } from 'bun'
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
    throw new Error(`${args.join(' ')}\n${stdout}\n${stderr}`)
  }
  return stdout
}

it('production auth joins and batched input work, then a quiet room closes when its global lease is denied', async () => {
  const root = process.cwd()
  const directory = await mkdtemp(join(tmpdir(), 'out-west-production-'))
  try {
    const output = join(directory, 'bundle')
    await execute([
      'node',
      join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'deploy',
      '--dry-run',
      '--config',
      join(root, 'api/test/wrangler.native-test.jsonc'),
      '--outdir',
      output,
    ])
    const entry = await readFile(join(output, 'production-worker.js'), 'utf8')
    const wasm = (await readdir(output)).filter((name) => name.endsWith('.wasm'))
    const packets = await build({
      entrypoints: [join(root, 'src/experiments/out-west/runtime/packets.ts')],
      target: 'node',
    })
    const packetModule = packets.outputs[0]
    if (!packetModule) {
      throw new Error('Packet module missing')
    }
    const code = await packetModule.text()
    const script = `
   import {Miniflare,convertV4MiniflareOptions} from ${JSON.stringify(join(root, 'node_modules/miniflare/dist/src/index.js'))};
   import fs from 'node:fs';
   delete globalThis.WebSocket;
   const {Client}=await import(${JSON.stringify(join(root, 'node_modules/@colyseus/sdk/build/index.mjs'))});
   const {batchInputs}=await import('data:text/javascript;base64,'+${JSON.stringify(Buffer.from(code).toString('base64'))});
   const modules=${JSON.stringify(wasm)}.map(name=>({type:'CompiledWasm',path:${JSON.stringify(root)}+'/'+name,contents:fs.readFileSync(${JSON.stringify(output)}+'/'+name)}));
   modules.unshift({type:'ESModule',path:${JSON.stringify(join(root, 'production-worker.js'))},contents:${JSON.stringify(entry)}});
   const durableObjects=Object.fromEntries(Object.entries({DUELS:'DuelSession',MATCHMAKER:'Matchmaker',DUEL_ROOMS:'DuelRoom',LOBBY_DIR:'LobbyDirectory',LOBBIES:'Lobby',DAILY_SESSIONS:'DailySession',SETTLEMENT:'SettlementProbe'}).map(([key,className])=>[key,{className,useSQLite:true}]));
   const mf=new Miniflare(convertV4MiniflareOptions({modules,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],durableObjects,d1Databases:{DB:'native-production'},bindings:{AUTH_SECRET:'fixture-native-production-secret',ALLOWED_ORIGINS:'http://127.0.0.1:4390',RP_ID:'localhost',TURNSTILE_SECRET:'fixture-provider-key',DISABLE_VOICE:'true'},outboundService:async request=>request.url.startsWith('https://challenges.cloudflare.com/turnstile/')?Response.json({success:true}):fetch(request)}));
   let room,other;
   try{
    const base=(await mf.ready).origin;
    const db=await mf.getD1Database('DB');
    for(const name of fs.readdirSync(${JSON.stringify(join(root, 'api/migrations'))}).filter(name=>name.endsWith('.sql')).sort()){
     const sql=fs.readFileSync(${JSON.stringify(join(root, 'api/migrations'))}+'/'+name,'utf8').replace(/^\\s*--.*$/gmu,'');
     const statements=sql.split(/;\\s*$/mu).map(value=>value.trim()).filter(Boolean);
     await db.batch(statements.map(sql=>db.prepare(sql)));
    }
    const staleBudget=await(await fetch(base+'/__test/stale-native-budget')).json();
    if(!staleBudget.replacementPreserved)throw new Error('Stale budget continuation crossed room generation');
    const account=await(await fetch(base+'/__test/seed')).json();
    const headers={Origin:'http://127.0.0.1:4390',Authorization:'Bearer '+account.token,'Content-Type':'application/json'};
    const abandonedResponse=await fetch(base+'/town/join',{method:'POST',headers,body:JSON.stringify({wire:10,protocol:${PROTOCOL_VERSION},collision:${JSON.stringify(COLLISION_VERSION)},turnstileToken:'fixture-provider-proof'})});
    const abandoned=await abandonedResponse.json();if(abandonedResponse.status!==201)throw new Error(JSON.stringify(abandoned));
    const timingUrl=base+'/__test/native-timing?lobbyId='+encodeURIComponent(abandoned.lobbyId);
    const waiting=await(await fetch(timingUrl)).json();
    if(waiting.timers.length||waiting.active||waiting.physics||waiting.core||waiting.tick!==0||waiting.timer||waiting.cleanup||waiting.lease||waiting.leaseTimer||waiting.seats!==1||!waiting.alarm)throw new Error('Reserved seat retained native resources instead of durable metadata: '+JSON.stringify(waiting));
    await new Promise(resolve=>setTimeout(resolve,31000));
    const expired=await(await fetch(timingUrl)).json();
    if(expired.timers.length||expired.active||expired.physics||expired.core||expired.timer||expired.running||expired.cleanup||expired.leaseTimer||expired.lease||expired.seats!==0||expired.alarm!==null)throw new Error('Abandoned reservation retained room duration or lease: '+JSON.stringify(expired));
    const closingResponse=await fetch(base+'/town/join',{method:'POST',headers,body:JSON.stringify({wire:10,protocol:${PROTOCOL_VERSION},collision:${JSON.stringify(COLLISION_VERSION)},turnstileToken:'fixture-provider-proof'})});
    const closingSeat=await closingResponse.json();
    await fetch(base+'/__test/delay-native-lease');
    const {WebSocket:RawSocket}=await import(${JSON.stringify(join(root, 'node_modules/ws/wrapper.mjs'))});
    const closing=new RawSocket(closingSeat.wsUrl+'&sessionId='+encodeURIComponent(closingSeat.reservation.sessionId),{headers:{Origin:headers.Origin}});
    await new Promise((resolve,reject)=>{closing.once('open',resolve);closing.once('error',reject)});
    const closedEarly=new Promise(resolve=>closing.once('close',resolve));closing.close();await closedEarly;
    await new Promise(resolve=>setTimeout(resolve,650));
    const early=await(await fetch(base+'/__test/native-timing?lobbyId='+encodeURIComponent(closingSeat.lobbyId))).json();
    const earlyLeases=await(await fetch(base+'/__test/native-leases')).json();
    if(early.active||early.physics||early.core||early.timer||early.lease||early.leaseTimer||early.humans||early.bots||earlyLeases.active)throw new Error('Close during delayed first lease resurrected native work: '+JSON.stringify({early,earlyLeases}));
    const response=await fetch(base+'/town/join',{method:'POST',headers,body:JSON.stringify({wire:10,protocol:${PROTOCOL_VERSION},collision:${JSON.stringify(COLLISION_VERSION)},turnstileToken:'fixture-provider-proof'})});
    const seat=await response.json();if(response.status!==201)throw new Error(JSON.stringify(seat));
    const warm=await(await fetch(base+'/__test/native-timing?lobbyId='+encodeURIComponent(seat.lobbyId))).json();
    try{await fetch(base+'/__test/restart-native?lobbyId='+encodeURIComponent(seat.lobbyId))}catch{}
    const cold=await(await fetch(base+'/__test/native-timing?lobbyId='+encodeURIComponent(seat.lobbyId))).json();
    if(cold.instance===warm.instance||cold.active||cold.physics||cold.core||cold.seats!==1||cold.lease)throw new Error('Cold metadata seat did not survive without native allocation: '+JSON.stringify({warm,cold}));
    await new Promise(resolve=>setTimeout(resolve,750));
    const client=new Client(base+'/town/'+seat.lobbyId+'?'+new URL(seat.wsUrl).searchParams.toString(),{headers:{Origin:headers.Origin}});
    room=await client.consumeSeatReservation(seat.reservation);room.reconnection.enabled=false;
    room.onMessage('control',()=>{});room.onMessage('events',()=>{});room.onMessage('network-ping',message=>setTimeout(()=>room.send('network-pong',{nonce:message.nonce}),100));
    await new Promise(resolve=>setTimeout(resolve,300));
    const visit=await db.prepare('SELECT id,left_at FROM ffa_sessions WHERE account_id=?').bind(account.accountId).all();
    if(visit.results.length!==1||visit.results[0].left_at!==null)throw new Error('Native authenticated join did not persist an open session: '+JSON.stringify(visit.results));
    const self=()=>[...room.state.players.values()].find(player=>player.sessionId===room.sessionId);
    const batches=batchInputs(room.connection),input=room.input({mode:'reliable'});
    Object.assign(input.data,{seq:1,moveX:.5,moveZ:0,yaw:.25,pitch:0,buttons:0,viewTime:0});input.send();
    Object.assign(input.data,{seq:2,yaw:.75});input.send();
    await new Promise(resolve=>setTimeout(resolve,500));
    const applied={seq:self()?.seq,yaw:self()?.yaw,tick:room.state.tick};batches.dispose();
    const linkStats=await(await fetch(base+'/town/'+seat.lobbyId+'/stats')).json();
    const measured=linkStats.links.find(link=>link.rtt.length>0);if(!measured||measured.rtt[0]<80)throw new Error('Native game judging did not measure trusted socket round trips: '+JSON.stringify(linkStats.links));
    const population=await(await fetch(base+'/__test/native-timing?lobbyId='+encodeURIComponent(seat.lobbyId))).json();
    if(population.bots!==4||population.humans!==1||!population.physics||!population.timer||!population.lease)throw new Error('Actual production bot population/lifecycle violated: '+JSON.stringify(population));
    const originalVisit=visit.results[0].id;
    await room.leave(false);await new Promise(resolve=>setTimeout(resolve,150));
    const empty=await(await fetch(base+'/__test/native-timing?lobbyId='+encodeURIComponent(seat.lobbyId))).json();
    if(empty.timers.some(timer=>timer.kind==='interval'||timer.delay>1000)||empty.active||empty.physics||empty.core||empty.timer||empty.running||empty.cleanup||empty.leaseTimer||empty.lease||empty.bots||empty.humans)throw new Error('Last online human left resident work: '+JSON.stringify(empty));
    await new Promise(resolve=>setTimeout(resolve,1500));
    const flushedEmpty=await(await fetch(base+'/__test/native-timing?lobbyId='+encodeURIComponent(seat.lobbyId))).json();
    if(flushedEmpty.timers.length||flushedEmpty.active||flushedEmpty.physics||flushedEmpty.lease)throw new Error('Final SDK flush retained recurring work: '+JSON.stringify(flushedEmpty));
    const rejoinResponse=await fetch(base+'/town/join',{method:'POST',headers,body:JSON.stringify({wire:10,protocol:${PROTOCOL_VERSION},collision:${JSON.stringify(COLLISION_VERSION)},turnstileToken:'fixture-provider-proof'})});
    const rejoinSeat=await rejoinResponse.json();if(rejoinResponse.status!==201)throw new Error(JSON.stringify(rejoinSeat));
    room=await new Client(base+'/town/'+rejoinSeat.lobbyId+'?'+new URL(rejoinSeat.wsUrl).searchParams.toString(),{headers:{Origin:headers.Origin}}).consumeSeatReservation(rejoinSeat.reservation);room.reconnection.enabled=false;
    room.onMessage('control',()=>{});room.onMessage('events',()=>{});room.onMessage('network-ping',message=>setTimeout(()=>room.send('network-pong',{nonce:message.nonce}),100));
    await new Promise(resolve=>setTimeout(resolve,300));
    const rejoinedVisit=await db.prepare('SELECT id,left_at FROM ffa_sessions WHERE account_id=?').bind(account.accountId).all();
    if(rejoinedVisit.results.length!==2||!rejoinedVisit.results.some(value=>value.id===originalVisit&&value.left_at!==null)||rejoinedVisit.results.filter(value=>value.left_at===null).length!==1)throw new Error('Fresh room return did not close and settle the zero-human visit: '+JSON.stringify(rejoinedVisit.results));
    await new Promise(resolve=>setTimeout(resolve,31000));
    const account2=await(await fetch(base+'/__test/seed')).json();
    const otherHeaders={...headers,Authorization:'Bearer '+account2.token};
    const otherResponse=await fetch(base+'/town/join',{method:'POST',headers:otherHeaders,body:JSON.stringify({wire:10,protocol:${PROTOCOL_VERSION},collision:${JSON.stringify(COLLISION_VERSION)},turnstileToken:'fixture-provider-proof'})});
    const otherSeat=await otherResponse.json();if(otherResponse.status!==201)throw new Error(JSON.stringify(otherSeat));
    other=await new Client(base+'/town/'+otherSeat.lobbyId+'?'+new URL(otherSeat.wsUrl).searchParams.toString(),{headers:{Origin:headers.Origin}}).consumeSeatReservation(otherSeat.reservation);other.reconnection.enabled=false;
    other.onMessage('control',()=>{});other.onMessage('events',()=>{});other.onMessage('network-ping',message=>other.send('network-pong',{nonce:message.nonce}));
    await new Promise(resolve=>setTimeout(resolve,300));
    const directory=await(await fetch(base+'/town/lobbies')).json();
    const occupied=directory.lobbies.find(value=>value.lobbyId===seat.lobbyId);
    if(occupied?.players!==2)throw new Error('Directory lost authenticated occupants after reservation expiry: '+JSON.stringify(directory));
    await fetch(base+'/__test/exhaust');
    let closed=false;room.onLeave(()=>{closed=true});
    const start=Date.now();while(!closed&&Date.now()-start<37000)await new Promise(resolve=>setTimeout(resolve,250));
    const closeElapsed=Date.now()-start;
    const beforeRefusal=await(await fetch(base+'/town/lobbies')).json();
    const account3=await(await fetch(base+'/__test/seed')).json();
    const denied=await fetch(base+'/town/join',{method:'POST',headers:{...headers,Authorization:'Bearer '+account3.token},body:JSON.stringify({wire:10,protocol:${PROTOCOL_VERSION},collision:${JSON.stringify(COLLISION_VERSION)},turnstileToken:'fixture-provider-proof'})});
    const deniedBody=await denied.json();
    const afterRefusal=await(await fetch(base+'/town/lobbies')).json();
    if(denied.status!==503||deniedBody.reason!=='over_budget'||JSON.stringify(beforeRefusal)!==JSON.stringify(afterRefusal))throw new Error('Lease denial did not gracefully release directory assignment: '+JSON.stringify({status:denied.status,deniedBody,beforeRefusal,afterRefusal}));
    const settlement=await(await fetch(base+'/__test/settlement')).json();
    try{await fetch(base+'/__test/restart-settlement')}catch{}
    const beforeRetry=await db.prepare('SELECT xp,purse FROM profiles WHERE account_id=?').bind(settlement.accountId).first();
    if(beforeRetry.xp!==75||beforeRetry.purse!==250)throw new Error('Expected failed recovery to retain pending deposit');
    await new Promise(resolve=>setTimeout(resolve,6500));
    await db.prepare('DROP TRIGGER reject_pending_deposit').run();
    const retryStarted=Date.now();let restoredProfile;
    do{await new Promise(resolve=>setTimeout(resolve,250));restoredProfile=await db.prepare('SELECT xp,purse FROM profiles WHERE account_id=?').bind(settlement.accountId).first()}while(restoredProfile.purse!==269&&Date.now()-retryStarted<14000);
    const orphanResponse=await mf.dispatchFetch('http://localhost/__test/orphan-socket',{headers:{Upgrade:'websocket'}});
    const orphan=orphanResponse.webSocket;
    if(!orphan)throw new Error('Missing orphan socket');orphan.accept();
    const orphanClosed=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Orphan socket silently ignored input')),2000);orphan.addEventListener('close',event=>{clearTimeout(timeout);resolve(event.code)})});
    orphan.send(new Uint8Array([13]));const orphanCode=await orphanClosed;
    await new Promise(resolve=>setTimeout(resolve,300));
    const restoredVisit=await db.prepare('SELECT left_at FROM ffa_sessions WHERE id=?').bind(settlement.visitId).first();
    const ledger=await db.prepare('SELECT COALESCE(SUM(xp),0) AS xp FROM ledger WHERE account_id=?').bind(settlement.accountId).first();
    console.log('RESULT:'+JSON.stringify({status:response.status,applied,closed,elapsed:closeElapsed,settlement,orphanCode,recoveredVisit:restoredVisit?.left_at!==null,restoredProfile,ledgerXp:ledger.xp}));
   }finally{if(room)await room.leave();if(other)await other.leave();await mf.dispose()}
  `
    const scriptPath = join(directory, 'run.mjs')
    await write(scriptPath, script)
    const stdout = await execute(['node', scriptPath])
    const line = stdout.split('\n').find((value) => value.startsWith('RESULT:'))
    if (!line) {
      throw new Error(stdout)
    }
    const result = JSON.parse(line.slice(7)) as {
      status: number
      applied: { seq: number; yaw: number; tick: number }
      closed: boolean
      elapsed: number
      settlement: {
        concurrentFlushed: number
        earned: number
        ambiguousEarned: number
        failedFlushed: number
        recovered: number
        leftAt: number | null
      }
      orphanCode: number
      recoveredVisit: boolean
      restoredProfile: { xp: number; purse: number }
      ledgerXp: number
    }
    expect(result.status).toBe(201)
    expect(result.applied.seq).toBe(2)
    expect((result.applied.yaw + Math.PI * 2) % (Math.PI * 2)).toBeCloseTo(0.75, 4)
    expect(result.applied.tick).toBeGreaterThan(5)
    expect(result.closed).toBe(true)
    expect(result.elapsed).toBeGreaterThan(20_000)
    expect(result.elapsed).toBeLessThan(37_000)
    expect(result.settlement).toMatchObject({
      concurrentFlushed: 30,
      earned: 45,
      ambiguousEarned: 55,
      failedFlushed: 55,
      recovered: 75,
      leftAt: null,
      pendingSql: 1,
      immediateAlarm: true,
    })
    expect(result.orphanCode).toBe(1012)
    expect(result.recoveredVisit).toBe(true)
    expect(result.restoredProfile).toEqual({ xp: 79, purse: 269 })
    expect(result.ledgerXp).toBe(result.restoredProfile.xp)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 150_000)
