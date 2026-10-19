import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {CatalogDB} from '../src/db.js';

test('HTTP queue exposes old recoveries; screenshot-only recapture, active guards, idempotent commits and release work together',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-http-'));const db=new CatalogDB(dir,{sqliteCacheMb:8});
  const point={x:.5,y:.5,kind:'buy'};db.importUrls(['https://www.pragmaticplay.fun/en/slots/api-root/']);const root=db.nextQueued();db.claim(root.id);
  db.ready(root.id,{capture_file:'/tmp/fake.jpg',capture:{state:'BASE',controls:[{path:'Button',hit:{x:0,y:0,w:1,h:1}}]}});
  const first=db.commit(root.id,[point]),buy=first.children[0].taskId;
  const shot=path.join(dir,'shots',`task-${buy}.jpg`);fs.mkdirSync(path.dirname(shot),{recursive:true});fs.writeFileSync(shot,'old-capture');
  db.db.prepare('UPDATE tasks SET capture_file=? WHERE id=?').run(shot,buy);
  db.importUrls(Array.from({length:35},(_,i)=>`https://www.pragmaticplay.fun/en/slots/api-problem-${i}/`));
  for(const task of db.queuedRoots(100))db.fail(task.id,'blocked','older ordinary problem');db.close();
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const browserUrl=new URL('../src/browser.js',import.meta.url).href,serverUrl=new URL('../src/server.js',import.meta.url).href;
  const bootstrap=`import fs from 'node:fs/promises';import {BrowserEngine} from ${JSON.stringify(browserUrl)};
    BrowserEngine.prototype.fresh=async(_url,task)=>({id:'api-rng',taskId:task.id,gameId:task.game_id,gameSymbol:'vs20test',events:[],context:{close:async()=>{}},page:{mouse:{click:async()=>{}}}});
    BrowserEngine.prototype.dismissConsent=async()=>{};BrowserEngine.prototype.openKnownIntro=async()=>{};BrowserEngine.prototype.settle=async()=>{};
    BrowserEngine.prototype.observe=async()=>({scan:{supported:true},state:'BASE',controls:[{path:'Button',hit:{x:0,y:0,w:1,h:1}}],clip:{x:0,y:0,width:800,height:600}});
    let shots=0;BrowserEngine.prototype.screenshot=async(session,taskId)=>{if(++shots===1)throw Error('API capture failed');if(taskId!==${buy})await new Promise(resolve=>setTimeout(resolve,500));const file=process.env.DATA_DIR+'/shots/task-'+taskId+'.jpg';await fs.writeFile(file,'new-capture-'+shots);return {file,capture:{sessionId:session.id,gameSymbol:session.gameSymbol,state:'BASE',controls:[{path:'Button',hit:{x:0,y:0,w:1,h:1}}]}};};
    await import(${JSON.stringify(serverUrl)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',bootstrap],{env:{...process.env,DATA_DIR:dir,PORT:String(port),WORKERS:'1',DISCOVERY_WORKERS:'0',BRANCH_WORKERS:'1',MAX_LIVE:'1'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}fs.rmSync(dir,{recursive:true,force:true});});
  const request=async(route,body)=>{const res=await fetch(`http://127.0.0.1:${port}${route}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  for(let i=0;;i++){try{await request('/api/status');break;}catch(e){if(i>100||child.exitCode!==null)throw Error(`Server failed: ${logs}: ${e}`);await new Promise(resolve=>setTimeout(resolve,10));}}
  const settings=(await request('/api/settings')).body;assert.match(settings.catalogId||'',/^[0-9a-f-]{36}$/);
  assert.equal((await request('/api/settings')).body.catalogId,settings.catalogId);assert.equal(JSON.stringify(settings).includes(dir),false);
  assert.deepEqual((await request(`/api/tasks/${root.id}/commit`,{marks:[point]})).body,first);
  await request('/api/run',{running:true});let queue;
  for(let i=0;i<100;i++){queue=(await request('/api/queue')).body;if(queue.recoveries?.length)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.deepEqual(queue.recoveries,[{id:buy,slug:'api-root',error:'API capture failed',live:true}]);assert.equal(queue.problems.some(x=>x.id===buy),false);
  const image=async()=>{const response=await fetch(`http://127.0.0.1:${port}/api/images/${buy}`);assert.equal(response.status,200);return response.text();};
  assert.equal(await image(),'old-capture');
  assert.deepEqual(await request(`/api/tasks/${buy}/recapture`,{}),{status:200,body:{ok:true}});
  assert.equal(await image(),'new-capture-2');
  queue=(await request('/api/queue')).body;assert.equal(queue.items[0].capture.sessionId,'api-rng');assert.equal(queue.items[0].capture.gameSymbol,'vs20test');
  assert.equal((await request(`/api/tasks/${buy}`)).body.task.live,true);
  assert.equal((await request(`/api/tasks/${root.id}`)).body.task.live,false);
  const marks=[{x:.5,y:.5,kind:'continue'}];const committed=await request(`/api/tasks/${buy}/commit`,{marks});assert.equal(committed.status,200);const continuation=committed.body.children[0].taskId;
  const retry=await request(`/api/tasks/${buy}/commit`,{marks});assert.equal(retry.status,200);assert.deepEqual(retry.body,committed.body);
  assert.equal((await request(`/api/tasks/${continuation}/release`,{})).status,409);
  assert.equal((await request(`/api/tasks/${continuation}/recapture`,{})).status,409);
  assert.equal((await request(`/api/tasks/${buy}/commit`,{marks:[]})).status,409);
  for(let i=0;i<100;i++){queue=(await request('/api/queue')).body;if(queue.items.some(x=>x.id===continuation))break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.deepEqual(await request(`/api/tasks/${continuation}/release`,{}),{status:200,body:{ok:true}});
  assert.match((await request(`/api/tasks/${continuation}`)).body.task.error,/RELEASED/);
  const lost=await request(`/api/tasks/${continuation}/recapture`,{});assert.equal(lost.status,400);assert.match(lost.body.error,/LIVE_SESSION_LOST/);
});

test('stale release cannot mutate active grandchildren or independent branches without owning their lease',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-http-owner-'));const db=new CatalogDB(dir,{sqliteCacheMb:8});
  const capture={state:'BASE',controls:[{path:'Button',hit:{x:0,y:0,w:1,h:1}}]};
  db.importUrls(['https://www.pragmaticplay.fun/en/slots/owner-rng/','https://www.pragmaticplay.fun/en/slots/owner-navigation/']);
  const [rngRoot,navRoot]=db.queuedRoots();
  for(const root of [rngRoot,navRoot]){db.claim(root.id);db.ready(root.id,{capture_file:'/tmp/fake.jpg',capture});}
  const buy=db.commit(rngRoot.id,[{x:.5,y:.5,kind:'buy'}]).children[0].taskId;
  const independent=db.commit(navRoot.id,[{x:.4,y:.5,kind:'navigate'},{x:.6,y:.5,kind:'navigate'}]).children.map(x=>x.taskId);
  const gateFromId=Math.max(...independent)+1;db.close();
  const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const bootstrap=`import fs from 'node:fs/promises';import {BrowserEngine} from ${JSON.stringify(new URL('../src/browser.js',import.meta.url).href)};
    BrowserEngine.prototype.fresh=async(_url,task)=>({id:'owned-rng',taskId:task.id,gameId:task.game_id,events:[],context:{close:async()=>{}},page:{mouse:{click:async()=>{}}}});
    BrowserEngine.prototype.dismissConsent=async()=>{};BrowserEngine.prototype.openKnownIntro=async()=>{};BrowserEngine.prototype.settle=async()=>{};
    BrowserEngine.prototype.observe=async()=>({scan:{supported:true},state:'BASE',controls:[{path:'Button',hit:{x:0,y:0,w:1,h:1}}],clip:{x:0,y:0,width:800,height:600}});
    BrowserEngine.prototype.screenshot=async(session,taskId)=>{if(taskId>=${gateFromId}){while(!await fs.access(process.env.DATA_DIR+'/capture-'+taskId+'.gate').then(()=>true,()=>false))await new Promise(resolve=>setTimeout(resolve,10));}return {file:'/tmp/fake.jpg',capture:{sessionId:session.id,state:'BASE',controls:[{path:'Button',hit:{x:0,y:0,w:1,h:1}}]}};};
    await import(${JSON.stringify(new URL('../src/server.js',import.meta.url).href)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',bootstrap],{env:{...process.env,DATA_DIR:dir,PORT:String(port),WORKERS:'1',DISCOVERY_WORKERS:'0',BRANCH_WORKERS:'1',MAX_LIVE:'1'},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
  t.after(async()=>{for(let id=gateFromId;id<gateFromId+5;id++)fs.writeFileSync(path.join(dir,`capture-${id}.gate`),'open');if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}fs.rmSync(dir,{recursive:true,force:true});});
  const request=async(route,body)=>{const res=await fetch(`http://127.0.0.1:${port}${route}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  for(let i=0;;i++){try{await request('/api/status');break;}catch(e){if(i>100||child.exitCode!==null)throw Error(`Server failed: ${logs}: ${e}`);await new Promise(resolve=>setTimeout(resolve,10));}}
  const waitTask=async(id,predicate)=>{for(let i=0;i<200;i++){const task=(await request(`/api/tasks/${id}`)).body.task;if(predicate(task))return task;await new Promise(resolve=>setTimeout(resolve,10));}throw Error(`Timed out waiting for task ${id}: ${JSON.stringify((await request(`/api/tasks/${id}`)).body)}`);};
  // A deterministic navigation ancestor has never owned an RNG lease.
  await t.test('never-owning ancestor cannot block independent queued children',async()=>{
    const neverOwned=await request(`/api/tasks/${navRoot.id}/release`,{});
    const statuses=await Promise.all(independent.map(async id=>(await request(`/api/tasks/${id}`)).body.task.status));
    assert.equal(neverOwned.status,400);assert.match(neverOwned.body.error,/LIVE_SESSION_LOST/);assert.deepEqual(statuses,['queued','queued']);
  });
  assert.equal((await request('/api/tasks/999999/release',{})).status,404);
  await t.test('two transfers leave stale ancestor release unable to mutate active grandchild',async()=>{
    await request('/api/run',{running:true});await waitTask(buy,x=>x.status==='ready');
    const marks=[{x:.5,y:.5,kind:'continue'}];
    const firstTransfer=await request(`/api/tasks/${buy}/commit`,{marks});assert.equal(firstTransfer.status,200);const continuation=firstTransfer.body.children[0].taskId;
    await waitTask(continuation,x=>x.status==='preparing'&&x.action_state==='dispatched');
    fs.writeFileSync(path.join(dir,`capture-${continuation}.gate`),'open');await waitTask(continuation,x=>x.status==='ready');
    const secondTransfer=await request(`/api/tasks/${continuation}/commit`,{marks});assert.equal(secondTransfer.status,200);const grandchild=secondTransfer.body.children[0].taskId;
    const before=await waitTask(grandchild,x=>x.status==='preparing'&&x.action_state==='dispatched');
    assert.equal((await request(`/api/tasks/${grandchild}/release`,{})).status,409);
    // buy is now neither owner nor busy, while its grandchild owns active work.
    const stale=await request(`/api/tasks/${buy}/release`,{});assert.equal(stale.status,400);assert.match(stale.body.error,/LIVE_SESSION_LOST/);
    const after=(await request(`/api/tasks/${grandchild}`)).body.task;
    assert.equal(after.status,'preparing');assert.equal(after.action_state,before.action_state);assert.equal(after.error,null);assert.equal(after.live,true);
    assert.equal((await request('/api/status')).body.live,1);
    fs.writeFileSync(path.join(dir,`capture-${grandchild}.gate`),'open');await waitTask(grandchild,x=>x.status==='ready');
    const item=(await request('/api/queue')).body.items.find(x=>x.id===grandchild);assert.equal(item.live,true);assert.equal(item.capture.sessionId,'owned-rng');
    assert.deepEqual(await request(`/api/tasks/${grandchild}/release`,{}),{status:200,body:{ok:true}});
    assert.equal((await request('/api/status')).body.live,0);assert.match((await request(`/api/tasks/${grandchild}`)).body.task.error,/RELEASED/);
  });
});
