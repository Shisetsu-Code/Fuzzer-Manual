import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {CatalogDB} from '../src/db.js';
import {BrowserEngine} from '../src/browser.js';
import {Scheduler} from '../src/scheduler.js';

const url=n=>`https://www.pragmaticplay.fun/en/slots/reliability-${n}/`;
const point=kind=>({x:.5,y:.5,kind});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-reliability-'));let db=new CatalogDB(dir,{sqliteCacheMb:8});
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,get db(){return db;},reopen(){db.close();db=new CatalogDB(dir,{sqliteCacheMb:8});return db;}};}
function ready(db,id,capture={state:'BASE',controls:[{path:'Button',hit:{x:0,y:0,w:1,h:1}}]}){assert.equal(db.claim(id),true);db.ready(id,{capture_file:'/tmp/fake.jpg',capture});}
function roots(db,n){db.importUrls(Array.from({length:n},(_,i)=>url(i)));return db.queuedRoots(n);}
function savedShot(db,capture){const file=path.join(path.dirname(db.path),'recovered.jpg');fs.writeFileSync(file,'snapshot');return {file,capture};}
function engineFor(db,options={}){const engine=new BrowserEngine({maxLive:1,viewportWidth:800,viewportHeight:600,...options},db);
  engine.fresh=async(_url,task)=>({id:`session-${task.id}`,taskId:task.id,context:{close:async()=>{}},events:[],page:{mouse:{click:async()=>{}}}});
  engine.dismissConsent=async()=>{};engine.observe=async()=>({scan:{supported:true},state:'BASE',controls:[{path:'Button',hit:{x:0,y:0,w:1,h:1}}],clip:{x:0,y:0,width:800,height:600}});
  engine.settle=async()=>{};engine.openKnownIntro=async()=>{};engine.openKnownBuyMenu=async()=>({opened:false});
  engine.screenshot=async(session,taskId)=>savedShot(db,{sessionId:session.id,state:'BASE',taskId});return engine;}
const cache={load:async()=>{},put:()=>{},stats:()=>({})};

test('first irreversible preparations reserve capacity before awaiting fresh browser I/O',async t=>{
  const {db}=fixture(t);const tasks=roots(db,2).map(root=>{ready(db,root.id);return db.getTask(db.commit(root.id,[point('buy')]).children[0].taskId);});
  const engine=engineFor(db);let finish;const gate=new Promise(resolve=>finish=resolve);const fresh=engine.fresh;let opened=0;
  engine.fresh=async(...args)=>{opened++;await gate;return fresh(...args);};
  for(const task of tasks)db.claim(task.id);
  const first=engine.prepare(tasks[0]);const second=engine.prepare(tasks[1]);const denied=assert.rejects(second,/LIVE_SLOTS_FULL/);
  finish();await Promise.all([first,denied]);assert.equal(opened,1);assert.equal(engine.liveCount(),1);await engine.stop();
});

test('failed inherited action belongs to child and recapture does not replay input',async t=>{
  const {db}=fixture(t);const [root]=roots(db,1);ready(db,root.id);const buy=db.commit(root.id,[point('buy')]).children[0].taskId;ready(db,buy);
  const child=db.commit(buy,[point('continue')]).children[0].taskId;const engine=engineFor(db);let clicks=0;
  engine.live.set(buy,{id:'original-rng',context:{close:async()=>{}},events:[],page:{mouse:{click:async()=>{clicks++;throw Error('input response lost');}}}});
  const scheduler=new Scheduler({db,browser:engine,cache,workers:1});db.claim(child);await scheduler.execute(db.getTask(child));
  assert.equal(engine.hasLive(buy),false);assert.equal(engine.hasLive(child),true);assert.equal(db.getTask(child).status,'failed');
  assert.equal(clicks,1);await scheduler.recapture(child);assert.equal(db.getTask(child).status,'ready');assert.equal(clicks,1);
  assert.equal(db.listReady()[0].capture.sessionId,'original-rng');await engine.stop();
});

test('fresh screenshot failure retains child and blocks release and duplicate work while recapturing',async t=>{
  const {db}=fixture(t);const [root]=roots(db,1);ready(db,root.id);const child=db.commit(root.id,[point('buy')]).children[0].taskId;
  const engine=engineFor(db);engine.screenshot=async()=>{throw Error('screenshot failed');};const scheduler=new Scheduler({db,browser:engine,cache});
  db.claim(child);await scheduler.execute(db.getTask(child));assert.equal(engine.hasLive(child),true);
  let finish;engine.screenshot=()=>new Promise(resolve=>finish=()=>resolve(savedShot(db,{sessionId:'retained'})));
  const recovery=scheduler.recapture(child);await assert.rejects(engine.release(child),/ACTIVE_WORK/);
  await assert.rejects(scheduler.recapture(child),/ACTIVE_WORK/);await assert.rejects(engine.prepare(db.getTask(child)),/ACTIVE_WORK/);
  finish();await recovery;assert.equal(db.getTask(child).status,'ready');await engine.stop();
});

test('scheduler finds retained continuation behind over 250 capacity-blocked branches',async t=>{
  const {db}=fixture(t);const [a,b]=roots(db,2);ready(db,a.id);ready(db,b.id);
  const nav=db.commit(a.id,Array.from({length:7},()=>point('navigate'))).children;
  const buy=db.commit(b.id,[point('buy')]).children[0].taskId;ready(db,buy);
  for(const n of nav){ready(db,n.taskId);db.commit(n.taskId,Array.from({length:40},()=>point('buy')));}
  const continuation=db.commit(buy,[point('continue')]).children[0].taskId;const engine=engineFor(db);engine.live.set(buy,{id:'rng'});
  let prepared=[];engine.prepare=async task=>{prepared.push(task.id);return {file:'/tmp/fake.jpg',capture:{state:'BASE'}};};
  db.setSetting('paused',false);const scheduler=new Scheduler({db,browser:engine,cache,workers:1});scheduler.pump();scheduler.stop();await scheduler.drain(2000);
  assert.deepEqual(prepared,[continuation]);
});

test('stop waits for pending Chromium launch and closes the resulting process',async()=>{
  let finish,closed=0;const engine=new BrowserEngine({gpuMode:'auto'},null,{chromiumLoader:async()=>({chromium:{launch:()=>new Promise(resolve=>finish=()=>resolve({close:async()=>closed++}))}})});
  const started=engine.start();const startResult=started.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));
  let stopped=false;const stop=engine.stop().then(()=>stopped=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
  finish();await Promise.all([startResult,stop]);assert.equal(closed,1);assert.equal(engine.browser,null);
});

test('iframe clip intersects negative coordinates and rejects offscreen bounds',()=>{
  const engine=new BrowserEngine({viewportWidth:800,viewportHeight:600},null);
  assert.deepEqual(engine.clipForBounds({x:-100,y:-50,width:400,height:300}),{x:0,y:0,width:300,height:250});
  assert.deepEqual(engine.clipForBounds({x:750,y:580,width:400,height:300}),{x:750,y:580,width:50,height:20});
  assert.throws(()=>engine.clipForBounds({x:-500,y:10,width:300,height:300}),/OUTSIDE_VIEWPORT/);
  assert.throws(()=>engine.clipForBounds({x:900,y:10,width:300,height:300}),/OUTSIDE_VIEWPORT/);
});

test('same normalized commit retries return original children; different marks conflict',t=>{
  const {db}=fixture(t);const [root]=roots(db,1);ready(db,root.id);
  const original=db.commit(root.id,[{...point('buy'),label:' Name ',x:.50000001}]);
  assert.deepEqual(db.commit(root.id,[{...point('buy'),label:'Name'}]),original);
  assert.equal(db.stats().marks,1);assert.throws(()=>db.commit(root.id,[point('continue')]),/conflict|already cataloged/i);
});

test('root lookups use an index and preserve legacy duplicate root rows',t=>{
  const f=fixture(t);roots(f.db,1);const plan=f.db.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE game_id=? AND parent_task_id IS NULL').all(1);
  assert.ok(plan.some(row=>/INDEX.*root/i.test(row.detail)),JSON.stringify(plan));
  // Existing catalogs may already violate the preferred unique invariant.
  f.db.db.exec('DROP INDEX IF EXISTS tasks_root_game; DROP INDEX IF EXISTS tasks_root_game_unique');
  f.db.db.exec("INSERT INTO tasks(game_id,depth,status) VALUES(1,0,'queued')");
  f.reopen();assert.equal(f.db.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,2);
});

test('restart blocks lost ready RNG snapshots and uncertain legacy irreversible preparations',t=>{
  const f=fixture(t),db=f.db;const [a,b]=roots(db,2);ready(db,a.id);ready(db,b.id);
  const readyBuy=db.commit(a.id,[point('buy')]).children[0].taskId;ready(db,readyBuy,{sessionId:'lost',state:'BASE'});
  const legacy=db.commit(b.id,[point('buy')]).children[0].taskId;db.db.prepare("UPDATE tasks SET status='preparing' WHERE id=?").run(legacy);
  f.reopen();assert.equal(f.db.getTask(readyBuy).status,'blocked');assert.match(f.db.getTask(readyBuy).error,/LIVE_SESSION_LOST/);
  assert.equal(f.db.getTask(legacy).status,'blocked');assert.match(f.db.getTask(legacy).error,/UNCERTAIN|checkpoint/i);
});

test('two-process crash after irreversible mouse dispatch never repeats the action',t=>{
  const f=fixture(t);const [root]=roots(f.db,1);ready(f.db,root.id);const id=f.db.commit(root.id,[point('buy')]).children[0].taskId;
  const program=`import fs from 'node:fs';import {CatalogDB} from ${JSON.stringify(new URL('../src/db.js',import.meta.url).href)};import {BrowserEngine} from ${JSON.stringify(new URL('../src/browser.js',import.meta.url).href)};
  const db=new CatalogDB(process.argv[1],{sqliteCacheMb:8}),task=db.nextQueued();if(!task){db.close();process.exit(0);}
  db.claim(task.id);const engine=new BrowserEngine({maxLive:1},db);engine.fresh=async()=>({id:'rng',events:[],context:{close:async()=>{}},page:{mouse:{click:async()=>fs.appendFileSync(process.argv[1]+'/actions','clicked\\n')}}});
  engine.dismissConsent=async()=>{};engine.observe=async()=>({scan:{supported:true},state:'BASE',controls:[{path:'Button',hit:{x:0,y:0,w:1,h:1}}],clip:{x:0,y:0,width:800,height:600}});engine.openKnownIntro=async()=>{};engine.settle=async()=>{};
  engine.screenshot=async()=>process.exit(86);await engine.prepare(task);`;
  const run=()=>spawnSync(process.execPath,['--input-type=module','-e',program,f.dir],{encoding:'utf8'});
  const first=run();assert.equal(first.status,86,first.stderr);f.reopen();assert.equal(f.db.getTask(id).status,'blocked');assert.match(f.db.getTask(id).error,/DISPATCHED|UNCERTAIN/);
  const second=run();assert.equal(second.status,0,second.stderr);assert.equal(fs.readFileSync(path.join(f.dir,'actions'),'utf8'),'clicked\n');
});

test('inherited screenshot failure remains recoverable on the child after the click',async t=>{
  const {db}=fixture(t);const [root]=roots(db,1);ready(db,root.id);const buy=db.commit(root.id,[point('buy')]).children[0].taskId;ready(db,buy);
  const child=db.commit(buy,[point('continue')]).children[0].taskId;const engine=engineFor(db);let clicks=0;
  engine.live.set(buy,{id:'inherited-rng',context:{close:async()=>{}},events:[],page:{mouse:{click:async()=>clicks++}}});
  engine.screenshot=async()=>{throw Error('capture failed after click');};db.claim(child);
  const scheduler=new Scheduler({db,browser:engine,cache});await scheduler.execute(db.getTask(child));
  assert.equal(engine.hasLive(child),true);assert.equal(engine.hasLive(buy),false);assert.equal(clicks,1);
  engine.screenshot=async()=>savedShot(db,{sessionId:'inherited-rng'});
  await scheduler.recapture(child);assert.equal(clicks,1);assert.equal(db.getTask(child).status,'ready');await engine.stop();
});

test('startup requeues verified pre-dispatch irreversible work and safe discovery only',t=>{
  const f=fixture(t);const [a,b]=roots(f.db,2);ready(f.db,a.id);const buy=f.db.commit(a.id,[point('buy')]).children[0].taskId;
  f.db.claim(buy);f.db.claim(b.id);f.reopen();assert.equal(f.db.getTask(buy).status,'queued');assert.equal(f.db.getTask(b.id).status,'queued');
});

test('recoveries include retained failures older than the limited problem list',t=>{
  const {db}=fixture(t);const all=roots(db,35);for(const task of all)db.fail(task.id,'failed','retained failure');
  assert.equal(db.listProblems(30).some(x=>x.id===all[0].id),false);
  assert.deepEqual(db.listRecoveries([all[0].id]),[{id:all[0].id,slug:'reliability-0',error:'retained failure',live:true}]);
});

test('release changes visible outcome and blocks queued descendants but preserves committed audit trail',t=>{
  const {db}=fixture(t);const [root]=roots(db,1);ready(db,root.id);const buy=db.commit(root.id,[point('buy')]).children[0].taskId;ready(db,buy);
  const child=db.commit(buy,[point('continue')]).children[0].taskId;db.releaseSession(buy);
  assert.equal(db.getTask(buy).status,'annotated');assert.match(db.getTask(buy).error,/RELEASED/);assert.equal(db.getTask(child).status,'blocked');
  db.releaseSession(child);assert.match(db.getTask(child).error,/RELEASED/);assert.equal(db.stats().marks,2);
});

test('release rejects an actively preparing inherited session before any mutation',async t=>{
  const {db}=fixture(t);const [root]=roots(db,1);ready(db,root.id);const buy=db.commit(root.id,[point('buy')]).children[0].taskId;ready(db,buy);
  const child=db.commit(buy,[point('continue')]).children[0].taskId;const engine=engineFor(db);engine.live.set(buy,{id:'rng',context:{close:async()=>{}},events:[],page:{mouse:{click:async()=>{}}}});
  let finish;engine.screenshot=()=>new Promise(resolve=>finish=()=>resolve({file:'/tmp/fake.jpg',capture:{}}));db.claim(child);const work=engine.prepare(db.getTask(child));
  await assert.rejects(engine.release(buy),/ACTIVE_WORK/);await assert.rejects(engine.release(child),/ACTIVE_WORK/);
  await assert.rejects(engine.prepare(db.getTask(child)),/ACTIVE_WORK/);assert.equal(engine.hasLive(child),true);
  while(!finish)await new Promise(resolve=>setImmediate(resolve));finish();await work;await engine.stop();
});

test('a failed fresh allocation returns capacity for another irreversible task',async t=>{
  const {db}=fixture(t);const tasks=roots(db,2).map(root=>{ready(db,root.id);return db.getTask(db.commit(root.id,[point('buy')]).children[0].taskId);});
  const engine=engineFor(db),fresh=engine.fresh;engine.fresh=async()=>{throw Error('context failed');};db.claim(tasks[0].id);
  await assert.rejects(engine.prepare(tasks[0]),/context failed/);assert.equal(engine.liveCount(),0);engine.fresh=fresh;db.claim(tasks[1].id);
  await engine.prepare(tasks[1]);assert.equal(engine.liveCount(),1);await engine.stop();
});

test('release continues occupying capacity until asynchronous context disposal finishes',async t=>{
  const {db}=fixture(t);const [root]=roots(db,1);ready(db,root.id);const child=db.getTask(db.commit(root.id,[point('buy')]).children[0].taskId);
  const engine=engineFor(db);let finish;engine.live.set(999,{context:{close:()=>new Promise(resolve=>finish=resolve)}});
  const release=engine.release(999);await new Promise(resolve=>setImmediate(resolve));assert.equal(engine.canPrepare(child),false);
  finish();await release;assert.equal(engine.canPrepare(child),true);await engine.stop();
});

test('late response completion after session disposal never attempts a closed database write',async t=>{
  const f=fixture(t),db=f.db;const [task]=roots(db,1);const callbacks={};let finish,writes=0;
  const record=db.recordNetworkEvent.bind(db);db.recordNetworkEvent=(...args)=>{writes++;return record(...args);};
  const page={on:(name,callback)=>callbacks[name]=callback};
  const chromium={launch:async()=>({newContext:async()=>({newPage:async()=>page,close:async()=>{}}),close:async()=>{}})};
  const engine=new BrowserEngine({gpuMode:'auto'},db,{chromiumLoader:async()=>({chromium})});engine.enter=async()=>{};
  const session=await engine.fresh(task.url,task);
  const request={url:()=> 'https://demogamesfree.pragmaticplay.net/gs2c/v3/gameService',method:()=> 'POST',postData:()=> 'action=doSpin'};
  callbacks.request(request);callbacks.response({request:()=>request,headers:()=>({'content-type':'text/plain'}),status:()=>200,text:()=>new Promise(resolve=>finish=resolve)});
  await engine.dispose(session);f.reopen();finish('action=doSpin&w=0');await Promise.allSettled([...session.pendingEvents]);
  assert.equal(writes,0);await engine.stop();
});

test('catalog identity is opaque, stable across reopen and distinct for fresh catalogs',t=>{
  const first=fixture(t),second=fixture(t);const id=first.db.getSetting('catalogId',null);
  assert.match(id||'',/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  first.reopen();assert.equal(first.db.getSetting('catalogId',null),id);assert.notEqual(second.db.getSetting('catalogId',null),id);
});
