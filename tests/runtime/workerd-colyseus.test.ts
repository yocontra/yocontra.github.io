import { expect, test as it } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { spawn, write } from 'bun'
import { Buttons, PROTOCOL_VERSION } from '../../src/experiments/out-west/runtime/protocol.ts'
import { hangTimeout } from '../timeout.ts'

async function execute(args: string[], source?: string) {
  const phase = source === undefined ? 'wrangler-dry-run' : 'native-room-scenarios'
  const child = spawn(args, {
    stdin: source === undefined ? 'ignore' : new Blob([source]),
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  })
  process.stderr.write(`[fixture ${phase} pid=${child.pid}] started\n`)
  const stop = () => {
    if (child.exitCode !== null) {
      return
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }
  }
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let output = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          return output
        }
        const text = decoder.decode(value, { stream: true })
        output = (output + text).slice(-256_000)
        process.stderr.write(text)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const watchdog = setTimeout(() => {
    process.stderr.write(`[fixture ${phase}]110s hang watchdog\n`)
    stop()
  }, hangTimeout(110_000))
  try {
    const [stdout, stderr, code] = await Promise.all([
      read(child.stdout),
      read(child.stderr),
      child.exited,
    ])
    if (code !== 0) {
      throw new Error(
        `${phase}: ${args.join(' ')}\n${stdout.slice(-16_000)}\n${stderr.slice(-16_000)}`,
      )
    }
    return stdout
  } finally {
    clearTimeout(watchdog)
    stop()
    await child.exited
  }
}

it(
  'Wrangler bundle sends autonomous Colyseus state to quiet clients in isolated Durable Objects',
  async () => {
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
      const protocolDeclaration = `var PROTOCOL_VERSION = ${PROTOCOL_VERSION};`
      expect(entry.split(protocolDeclaration)).toHaveLength(2)
      // The legacy-version fixture executes the same real onJoin comparator, before any game decoding.
      const legacyEntry = entry.replace(
        protocolDeclaration,
        `var PROTOCOL_VERSION = ${PROTOCOL_VERSION - 1};`,
      )
      const script = `
  import {Miniflare,convertV4MiniflareOptions} from ${JSON.stringify(join(root, 'node_modules/miniflare/dist/src/index.js'))};
  import {Client} from ${JSON.stringify(join(root, 'node_modules/@colyseus/sdk/build/index.mjs'))};
  import fs from 'node:fs';
  let diagnostic=async()=>null;
  const waitFor=async(read,done,label)=>{const start=Date.now();let value;do{value=await read();if(done(value))return value;await new Promise(resolve=>setTimeout(resolve,50))}while(Date.now()-start<30000);throw new Error('Timed out: '+label+' '+JSON.stringify({value,diagnostic:await diagnostic().catch(e=>({error:String(e)}))}))};
  const modules=${JSON.stringify(moduleFiles)}.map(name=>({type:'CompiledWasm',path:${JSON.stringify(root)}+'/'+name,contents:fs.readFileSync(${JSON.stringify(output)}+'/'+name)}));
  modules.unshift({type:'ESModule',path:${JSON.stringify(join(root, 'worker.js'))},contents:${JSON.stringify(entry)}});
  const mf=new Miniflare(convertV4MiniflareOptions({modules,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOMS:{className:'TestRoom',useSQLite:true}}}));
  const rooms=[];
  try{
   const base=(await mf.ready).origin;
   diagnostic=async()=>await(await fetch(base+'/environment/inspect?room=first',{signal:AbortSignal.timeout(1000)})).json();
   console.log('PHASE: versioned native handshakes');
   const rejected=async(origin,protocol,tag)=>{
    const seat=await(await fetch(origin+'/reserve?account=version-'+tag+'&room='+tag+'&protocol='+protocol)).json();
    let failure;try{const unexpected=await new Client(origin+'?account=version-'+tag).consumeSeatReservation(seat);await unexpected.leave()}catch(e){failure=String(e)}
    if(!failure?.includes('Refresh the game'))throw new Error('Mismatched native handshake accepted: '+JSON.stringify({tag,protocol,failure}));
    const stopped=await(await fetch(origin+'/timing?room='+tag)).json();if(stopped.physics||stopped.running||stopped.timer)throw new Error('Rejected handshake started gameplay: '+JSON.stringify(stopped));
    return {tag,protocol,failure,stopped};
   };
   const oldClient=await rejected(base,${PROTOCOL_VERSION - 1},'old-client-new-server');
   const oldModules=modules.map(m=>m.type==='ESModule'?{...m,contents:${JSON.stringify(legacyEntry)}}:m);
   const oldMf=new Miniflare(convertV4MiniflareOptions({modules:oldModules,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],durableObjects:{ROOMS:{className:'TestRoom',useSQLite:true}}}));
   let newClient;try{newClient=await rejected((await oldMf.ready).origin,${PROTOCOL_VERSION},'new-client-old-server')}finally{await oldMf.dispose()}
   console.log('PROTOCOL:'+JSON.stringify({oldClient,newClient,current:${PROTOCOL_VERSION}}));
   console.log('PHASE: autonomous rooms and first-join lifecycle');
   const seatsCheck=await(await fetch(base+'/seats?room=seat-probe')).json();
   if(!seatsCheck.accountBound||!seatsCheck.lobbyBound||!seatsCheck.oneUse||!seatsCheck.expired||!seatsCheck.replaced)throw new Error('Durable seat binding failed');
   const clock=await(await fetch(base+'/clock?room=clock-probe')).json();
   if(JSON.stringify(clock.steps)!==JSON.stringify([1,1,2,5,5,1])||!clock.disposed)throw new Error('Clock regression: '+JSON.stringify(clock));
   await fetch(base+'/reserve?account=unused&room=unused-seat');
   await new Promise(resolve=>setTimeout(resolve,250));
   const unused=await(await fetch(base+'/timing?room=unused-seat')).json();
   if(unused.tick!==0||unused.running||unused.timer||unused.elapsed!==0||unused.physics)throw new Error('Unused seat ran native work: '+JSON.stringify(unused));
   await fetch(base+'/dispose?room=unused-seat');
   const stopped=await(await fetch(base+'/timing?room=unused-seat')).json();
   await new Promise(resolve=>setTimeout(resolve,150));
   const stillStopped=await(await fetch(base+'/timing?room=unused-seat')).json();
   if(stopped.running||stopped.timer||stillStopped.elapsed!==stopped.elapsed)throw new Error('Disposed unused seat retained a timer');
   const closingSeat=await(await fetch(base+'/reserve?account=closing&room=close-before-join&holdStart=1')).json();
   const closing=new WebSocket(base.replace('http:','ws:')+'/native/'+closingSeat.roomId+'?account=closing&sessionId='+closingSeat.sessionId);
   await new Promise((resolve,reject)=>{closing.addEventListener('open',resolve,{once:true});closing.addEventListener('error',reject,{once:true})});
   const didClose=new Promise(resolve=>closing.addEventListener('close',resolve,{once:true}));closing.close();await didClose;
   await new Promise(resolve=>setTimeout(resolve,650));
   const closedJoin=await(await fetch(base+'/timing?room=close-before-join')).json();
   if(closedJoin.physics||closedJoin.running||closedJoin.timer||closedJoin.tick!==0||closedJoin.elapsed!==0)throw new Error('Close during first join resurrected native work: '+JSON.stringify(closedJoin));
   const seats=[];
   for(const [account,which]of [['alice','first'],['bob','first'],['carol','second']]){
    const reservation=await(await fetch(base+'/reserve?account='+account+'&room='+which)).json();
    seats.push({account,reservation});
   }
   await new Promise(resolve=>setTimeout(resolve,750));
   const delayedJoin=await(await fetch(base+'/timing?room=first')).json();
   if(delayedJoin.tick!==0||delayedJoin.elapsed!==0||delayedJoin.running||delayedJoin.physics||delayedJoin.timer)throw new Error('Reserved room advanced gameplay before delayed join: '+JSON.stringify(delayedJoin));
   rooms.push(...await Promise.all(seats.map(async({account,reservation})=>{
    const room=await new Client(base+'?account='+account).consumeSeatReservation(reservation);
    room.onMessage('control',()=>{});room.onMessage('events',()=>{});room.onMessage('network-ping',message=>room.send('network-pong',{nonce:message.nonce}));return room;
   })));
   await new Promise(resolve=>setTimeout(resolve,1000));
   const before=rooms.map(room=>room.state.tick);
   const timingBefore=await(await fetch(base+'/timing?room=first')).json();
   // Quiet clients must keep receiving at least 41 autonomous ticks; a starved host may take longer than 2 s.
   await waitFor(()=>rooms.map(room=>room.state.tick),ticks=>ticks.every((tick,i)=>tick-before[i]>40),'autonomous ticks');
   const timingAfter=await(await fetch(base+'/timing?room=first')).json();
   // A fixed 20 Hz step can lag a starved host (fewer ticks), but never run ahead of its clock.
   const clockRatio=(timingAfter.elapsed-timingBefore.elapsed)/((timingAfter.tick-timingBefore.tick)*50);
   if(!(clockRatio>.8))throw new Error('Room has extra clock ticks: '+JSON.stringify({timingBefore,timingAfter,clockRatio}));
   const after=rooms.map(room=>({tick:room.state.tick,players:room.state.players.size,own:[...room.state.players.values()].some(player=>player.sessionId===room.sessionId)}));
   const currentInput=rooms[0].input({mode:'reliable'});Object.assign(currentInput.data,{seq:42,moveX:.5,moveZ:0,yaw:0,pitch:0,buttons:0,viewTime:0});currentInput.send();
   await waitFor(()=>[...rooms[0].state.players.values()].some(player=>player.sessionId===rooms[0].sessionId&&player.seq===42),Boolean,'Current SDK input stopped working');
   // Real room/input/state transport: four-cell barrel covers, two peers and a later joining third.
   console.log('PHASE: eight individual barrels');
   const setup=await(await fetch(base+'/environment/setup?room=first')).json();
   if(setup.props?.length!==8||setup.props.some(h=>h!==68))throw new Error('Barrel setup state invalid');
   const health=room=>JSON.parse(room.state.game).props;
   const own=room=>[...room.state.players.values()].find(p=>p.sessionId===room.sessionId);
   let envSeq=42;
   const sendEnv=async(buttons,moveX=0,moveZ=0)=>{
    const seq=++envSeq;
    Object.assign(currentInput.data,{seq,moveX,moveZ,yaw:-Math.PI/2,pitch:-10/127*Math.PI/2,buttons,viewTime:rooms[0].state.tick-1});currentInput.send();
    await waitFor(()=>own(rooms[0])?.seq,n=>n===seq,'barrel command acknowledgement');
   };
   await sendEnv(1026);
   for(const [slot,wanted]of [[0,34],[0,0],[2,34],[2,0]]){
    console.log('PHASE: shoot barrel '+slot+' expected '+wanted);
    await sendEnv(1026);await waitFor(()=>own(rooms[0])?.fireCooldownMs,n=>n<=0,'original fire cooldown');
    await sendEnv(1027);
    await waitFor(()=>rooms.slice(0,2).map(r=>health(r)[slot]),values=>values.every(h=>h===wanted),'two-peer barrel health');
   }
   console.log('PHASE: third SDK client late join');
   const lateSeat=await(await fetch(base+'/reserve?account=late-barrel&room=first')).json();
   const late=await new Client(base+'?account=late-barrel').consumeSeatReservation(lateSeat);rooms.push(late);
   const lateBreaks=[];late.onMessage('events',m=>lateBreaks.push(...m.events.filter(e=>e.type==='prop_break')));late.onMessage('control',()=>{});late.onMessage('network-ping',m=>late.send('network-pong',{nonce:m.nonce}));
   await waitFor(()=>late.state.game,Boolean,'late barrel snapshot');
   if(JSON.stringify(health(late))!==JSON.stringify(health(rooms[0])))throw new Error('Late join restored intact barrels');
   // Release aim before the late-join shot so slow clients cannot charge Dead Eye.
   await sendEnv(${Buttons.crouch});
   await waitFor(()=>own(rooms[0])?.fireCooldownMs,n=>n<=0,'next shot cooldown');
   await sendEnv(${Buttons.crouch | Buttons.fire});
   await waitFor(()=>own(rooms[1])?.hp,n=>n===66,'next shot through broken barrels');
   const laterTick=late.state.tick;await waitFor(()=>late.state.tick,n=>n>laterTick+2,'late-join observation');
   if(lateBreaks.length)throw new Error('Late join replayed historic barrel breaks');
   const environment={health:health(late),shooterAmmo:own(rooms[0]).ammo,targetHp:own(rooms[1]).hp,lateBreaks:lateBreaks.length};
   if(environment.shooterAmmo!==1)throw new Error('Barrel response changed six-round ammo');
   await late.leave();
   console.log('ENVIRONMENT:'+JSON.stringify(environment));
   await rooms[0].leave();await rooms[1].leave();
   console.log('PHASE: zero-human disposal');
   const emptyEnvironment=await waitFor(async()=>await(await fetch(base+'/environment/inspect?room=first')).json(),x=>!x.physics&&!x.running,'last-human barrel world disposal');
   if(emptyEnvironment.buffers!==0||emptyEnvironment.textures!==0)throw new Error('Barrel room retained native resources: '+JSON.stringify(emptyEnvironment));

   console.log('PHASE: independent room isolation');
   const independentHealth=health(rooms[2]);if(independentHealth.length!==8||independentHealth.some(h=>h!==68))throw new Error('Barrel damage escaped its room: '+JSON.stringify(independentHealth));
   console.log('PHASE: fresh actual native room after old room shutdown');
   const freshSeat=await(await fetch(base+'/reserve?account=fresh-barrel&room=fresh-barrel-world')).json();
   const fresh=await new Client(base+'?account=fresh-barrel').consumeSeatReservation(freshSeat);rooms.push(fresh);
   const freshBreaks=[];fresh.onMessage('events',m=>freshBreaks.push(...m.events.filter(e=>e.type==='prop_break')));fresh.onMessage('control',()=>{});fresh.onMessage('network-ping',m=>fresh.send('network-pong',{nonce:m.nonce}));
   await waitFor(()=>fresh.state.game,Boolean,'fresh-world snapshot');
   const freshNative=await(await fetch(base+'/environment/inspect?room=fresh-barrel-world')).json();
   if(health(fresh).length!==8||health(fresh).some(h=>h!==68)||!freshNative.physics||!freshNative.running||freshBreaks.length)throw new Error('Fresh world failed to restore barrel ownership: '+JSON.stringify({freshNative,freshBreaks}));
   console.log('PHASE: authoritative tumbleweed and late join');
   const weedAimResponse=await fetch(base+'/environment/setup-weed?room=fresh-barrel-world');
   if(!weedAimResponse.ok)throw new Error('Native weed setup failed '+await weedAimResponse.text());
   const weedAim=await weedAimResponse.json();
   const weedInput=fresh.input({mode:'reliable'});
   Object.assign(weedInput.data,{seq:1,moveX:0,moveZ:0,yaw:-Math.PI/2,pitch:weedAim.pitch,buttons:${Buttons.crouch | Buttons.fire},viewTime:weedAim.tick});weedInput.send();
   const weeds=room=>room.state.game?JSON.parse(room.state.game).tumbleweeds:undefined;
   const activeWeeds=await waitFor(()=>weeds(fresh),value=>value?.[0]?.vx>1,'native shot pushes weed');
   const weedSeat=await(await fetch(base+'/reserve?account=late-weed&room=fresh-barrel-world')).json();
   const weedGuest=await new Client(base+'?account=late-weed').consumeSeatReservation(weedSeat);rooms.push(weedGuest);
   weedGuest.onMessage('events',()=>{});weedGuest.onMessage('control',()=>{});weedGuest.onMessage('network-ping',m=>weedGuest.send('network-pong',{nonce:m.nonce}));
   await waitFor(()=>weedGuest.state.game,Boolean,'late weed state');
   if(JSON.stringify(weeds(weedGuest))!==JSON.stringify(activeWeeds))throw new Error('Late join did not receive the same weed motion '+JSON.stringify({guest:weeds(weedGuest),activeWeeds}));
   if(weeds(rooms[2]))throw new Error('Independent room inherited a weed impulse');
   await waitFor(()=>[weeds(fresh),weeds(weedGuest)],items=>items.every(value=>value===undefined),'shared tumbleweed expiry');
   await weedGuest.leave();
   console.log('TUMBLEWEED:'+JSON.stringify({motion:activeWeeds,isolation:true,expired:true}));
   await fresh.leave();
   const freshEmpty=await waitFor(async()=>await(await fetch(base+'/environment/inspect?room=fresh-barrel-world')).json(),x=>!x.physics&&!x.running,'fresh room zero-human disposal');
   if(freshEmpty.buffers!==0||freshEmpty.textures!==0)throw new Error('Fresh native room retained resources: '+JSON.stringify(freshEmpty));
   console.log('FRESH:'+JSON.stringify({health:freshNative.props,historicBreaks:freshBreaks.length,independentHealth,empty:{buffers:freshEmpty.buffers,textures:freshEmpty.textures,physics:freshEmpty.physics,running:freshEmpty.running}}));
   const otherContinued=await waitFor(()=>rooms[2].state.tick>after[2].tick,Boolean,'other room stopped after unrelated leaves');
   console.log('RESULT:'+JSON.stringify({before,after,otherContinued}));
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
  }finally{const closing=Promise.allSettled(rooms.map(room=>room.leave()));await mf.dispose();await closing}
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
      expect(stdout).toContain('TUMBLEWEED:')
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
  },
  hangTimeout(120_000),
)
