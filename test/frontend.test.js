import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Small DOM boundary for running the actual browser entry point in Node.
// No application functions are copied here; actions use its registered handlers.
class Element{
  constructor(tagName='DIV'){this.tagName=tagName;this.children=[];this.listeners=new Map();this.style={};this.dataset={};this.attributes={};this.textContent='';this.className='';this.disabled=false;this.hidden=false;this.value='';this.classList={toggle(){}};}
  addEventListener(type,fn){const handlers=this.listeners.get(type)||[];handlers.push(fn);this.listeners.set(type,handlers);}
  async emit(type,props={}){if(type==='click'&&this.disabled)return;const e={target:this,preventDefault(){},...props};for(const fn of this.listeners.get(type)||[])fn(e);}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;this.textContent='';}
  getAttribute(name){return this.attributes[name]??null;}
  set src(value){this.attributes.src=value;}
  removeAttribute(name){delete this.attributes[name];}
  closest(){return null;}
  getBoundingClientRect(){return {left:0,top:0,width:100,height:100};}
  showModal(){} close(){}
}
const photo=id=>({id,slug:`photo-${id}`,game_id:id,depth:0,capture:{state:'ready'},status:'ready',live:false});
const tick=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
async function harness({initialQueue,storage,details=new Map(),settings={catalogId:'test-catalog',hotkeys:{next:'KeyN',skip:'KeyK'}}}={}){
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],new Element()]));
  const doc=new Element();doc.getElementById=id=>nodes.get(id);doc.createElement=tag=>new Element(tag.toUpperCase());doc.createTextNode=text=>({textContent:text});doc.querySelectorAll=()=>[];doc.visibilityState='visible';
  const calls=[],saves=[],recoveryRequests=[],imageSources=[];let queue=initialQueue||{items:[photo(1),photo(2),photo(3)],problems:[],recoveries:[{id:9,slug:'failed-live',error:'capture failed',live:true}]};
  const globals=['document','window','Image','fetch','setInterval','localStorage','confirm'];const originals=Object.fromEntries(globals.map(key=>[key,globalThis[key]]));
  Object.assign(globalThis,{document:doc,window:new Element(),Image:class{set src(value){imageSources.push(value);}},setInterval:()=>0,confirm:()=>true,localStorage:storage||{getItem:()=>null,setItem(){}}});globalThis.window.localStorage=globalThis.localStorage;
  globalThis.fetch=async(url,options={})=>{
    const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
    if(url.endsWith('/commit'))return new Promise((resolve,reject)=>saves.push({url,body,resolve,reject}));
    if(url.endsWith('/recapture')||url.endsWith('/release'))return new Promise(resolve=>recoveryRequests.push({url,body,resolve}));
    if(url==='/api/settings'&&settings instanceof Error)throw settings;
    const taskId=Number(url.match(/^\/api\/tasks\/(\d+)$/)?.[1]);
    const data=taskId?(details.get(taskId)||{task:photo(taskId),marks:[]}):url.startsWith('/api/queue')?queue:url==='/api/status'?{db:{games:3,tasks:{ready:3},marks:0},active:0,workers:1,live:1,maxLive:4}:url==='/api/settings'?settings:url.includes('/trace')?{events:[]}:{};
    return {ok:true,json:async()=>data};
  };
  await import(`../public/app.js?test=${Math.random()}`);await tick();
  return {nodes,doc,calls,saves,recoveryRequests,imageSources,details,setQueue:value=>queue=value,
    click:async id=>{await nodes.get(id).emit('click',{clientX:20,clientY:30});await tick();},
    key:async(code,repeat=false)=>{await doc.emit('keydown',{code,repeat});await tick();},
    row:slug=>nodes.get('queue-list').children.find(row=>row.children[0]?.textContent===slug),
    close(){for(const key of globals){if(originals[key]===undefined)delete globalThis[key];else globalThis[key]=originals[key];}}};
}
const response=(ok,data)=>({ok,status:ok?200:409,json:async()=>data});

test('actual app preserves B after A fails, retries A payload and ignores held configurable advance keys',async()=>{
  const h=await harness();try{
    await h.click('image-wrap');await h.key('KeyN');assert.equal(h.saves.length,1);assert.match(h.nodes.get('game-subtitle').textContent,/Foto #2/);
    await h.click('image-wrap');await h.key('KeyN',true);await h.key('KeyK',true);assert.equal(h.saves.length,1,'held advance/skip must not send requests');
    h.saves[0].reject(new TypeError('network lost'));await tick();
    assert.match(h.nodes.get('game-subtitle').textContent,/Foto #2/);assert.equal(h.nodes.get('pins').children.length,1);
    await h.row('photo-1').emit('click');await tick();await h.click('save-btn');
    assert.deepEqual(h.saves[1].body,h.saves[0].body);h.saves[1].resolve(response(true,{}));await tick();
    assert.match(h.nodes.get('game-subtitle').textContent,/Foto #2/);assert.equal(h.nodes.get('pins').children.length,1);assert.equal(h.row('photo-1'),undefined,'stale queue cannot restore acknowledged A');
    await h.click('previous-btn');assert.match(h.nodes.get('photo-status').textContent,/REVISIÓN/);await h.key('KeyN');
    assert.match(h.nodes.get('game-subtitle').textContent,/Foto #2/);assert.equal(h.nodes.get('pins').children.length,1);
  }finally{h.close();}
});

test('actual app renders retained sessions, shows recapture/release errors and preserves the current draft',async()=>{
  const h=await harness();try{
    await h.click('image-wrap');const list=h.nodes.get('recoveries');assert.ok(list,'recovery section is present');assert.equal(list.children.length,1);
    let buttons=list.children[0].children.filter(child=>child.tagName==='BUTTON');assert.deepEqual(buttons.map(b=>b.textContent),['Recapturar','Liberar']);
    await buttons[0].emit('click');assert.equal(h.recoveryRequests[0].url,'/api/tasks/9/recapture');assert.deepEqual(h.recoveryRequests[0].body,{});
    h.recoveryRequests[0].resolve(response(false,{error:'session busy'}));await tick();assert.match(list.children[0].textContent+list.children[0].children.map(n=>n.textContent).join(' '),/session busy/);
    assert.equal(h.nodes.get('pins').children.length,1);
    buttons=list.children[0].children.filter(child=>child.tagName==='BUTTON');await buttons[1].emit('click');assert.equal(h.recoveryRequests[1].url,'/api/tasks/9/release');
    h.recoveryRequests[1].resolve(response(false,{error:'release busy'}));await tick();assert.match(list.children[0].children.map(n=>n.textContent).join(' '),/release busy/);
    buttons=list.children[0].children.filter(child=>child.tagName==='BUTTON');await buttons[0].emit('click');
    h.setQueue({items:[photo(1),photo(2),photo(9)],problems:[],recoveries:[]});h.recoveryRequests[2].resolve(response(true,{task:photo(9)}));await tick();
    assert.equal(list.children.length,0);assert.ok(h.row('photo-9'));assert.equal(h.nodes.get('pins').children.length,1);assert.match(h.nodes.get('game-subtitle').textContent,/Foto #1/);
  }finally{h.close();}
});

test('drafts omitted from a full queue page remain reachable through actual queue navigation',async()=>{
  const h=await harness();try{
    await h.click('image-wrap');h.setQueue({items:Array.from({length:250},(_,i)=>photo(i+10)),problems:[],recoveries:[]});await h.click('refresh-btn');
    assert.ok(h.row('photo-1'),'retained draft must be visible beyond the server page limit');
    await h.row('photo-10').emit('click');await tick();await h.row('photo-1').emit('click');await tick();assert.equal(h.nodes.get('pins').children.length,1);
  }finally{h.close();}
});

test('known LIVE and depth validation leave A editable and preserve B draft',async()=>{
  for(const invalid of [{live:true},{depth:24}]){
    const h=await harness({initialQueue:{items:[{...photo(1),...invalid},photo(2)],problems:[],recoveries:[]}});try{
      await h.row('photo-2').emit('click');await tick();await h.click('image-wrap');await h.row('photo-1').emit('click');await tick();
      await h.click('image-wrap');await h.click('image-wrap');await h.key('KeyN');
      assert.equal(h.saves.length,0,'known invalid marks must not become immutable pending HTTP work');
      assert.equal(h.nodes.get('undo-btn').disabled,false);assert.match(h.nodes.get('game-subtitle').textContent,/Foto #1/);
      if(invalid.live)await h.click('undo-btn');else await h.click('clear-btn');
      await h.click('save-btn');assert.equal(h.saves.length,1);assert.equal(h.saves[0].body.marks.length,invalid.live?1:0);
      assert.match(h.nodes.get('game-subtitle').textContent,/Foto #2/);assert.equal(h.nodes.get('pins').children.length,1);h.saves[0].resolve(response(true,{}));await tick();
    }finally{h.close();}
  }
});

test('confirmed ready/uncommitted rejection unlocks only A; committed or unknown outcomes stay frozen',async()=>{
  const h=await harness();try{
    await h.click('image-wrap');await h.click('image-wrap');await h.key('KeyN');await h.click('image-wrap');
    h.details.set(1,{task:{...photo(1),live:true},marks:[]});h.saves[0].resolve(response(false,{error:'select one live action'}));await tick();
    assert.ok(h.calls.some(call=>call.url==='/api/tasks/1'),'HTTP rejection must be confirmed through authoritative task detail');
    assert.match(h.nodes.get('game-subtitle').textContent,/Foto #2/);assert.equal(h.nodes.get('pins').children.length,1);
    await h.row('photo-1').emit('click');await tick();assert.equal(h.nodes.get('undo-btn').disabled,false);await h.click('undo-btn');await h.key('KeyN');assert.equal(h.saves[1].body.marks.length,1);
    h.details.set(1,{task:{...photo(1),status:'annotated'},marks:[{x:.2,y:.3,kind:'navigate',label:''}]});h.saves[1].resolve(response(false,{error:'response interrupted'}));await tick();
    await h.row('photo-1').emit('click');await tick();assert.equal(h.nodes.get('undo-btn').disabled,true);await h.key('KeyN');assert.deepEqual(h.saves[2].body,h.saves[1].body);h.saves[2].resolve(response(true,{}));await tick();
  }finally{h.close();}
});

test('explicit problem and retained recovery keep A draft read-only while B stays editable',async()=>{
  const h=await harness();try{
    await h.click('image-wrap');await h.row('photo-2').emit('click');await tick();await h.click('image-wrap');
    for(const state of ['problem','recovery']){
      h.setQueue({items:[photo(2)],problems:state==='problem'?[{id:1,slug:'photo-1',status:'blocked',error:'LIVE_SESSION_LOST'}]:[],recoveries:state==='recovery'?[{id:1,slug:'photo-1',live:true,error:'recapture required'}]:[]});await h.click('refresh-btn');
      assert.match(h.nodes.get('game-subtitle').textContent,/Foto #2/);assert.equal(h.nodes.get('pins').children.length,1);
      await h.row('photo-1').emit('click');await tick();assert.equal(h.nodes.get('pins').children.length,1);assert.equal(h.nodes.get('save-btn').disabled,true);assert.equal(h.nodes.get('undo-btn').disabled,true);
      assert.match(h.nodes.get('hint').textContent,state==='problem'?/LIVE_SESSION_LOST/:/recapture required/);await h.key('KeyN');assert.equal(h.saves.length,0);
      await h.row('photo-2').emit('click');await tick();assert.equal(h.nodes.get('undo-btn').disabled,false);assert.equal(h.nodes.get('pins').children.length,1);
    }
  }finally{h.close();}
});

test('restored LIVE draft follows real DB restart loss even when absent from bounded problem lists',async()=>{
  const {CatalogDB}=await import(process.env.FRONTEND_DB_MODULE||'../src/db.js');
  const {AnnotationState}=await import('../public/annotations.js');
  const {mkdtemp,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'frontend-restart-'));let db;
  try{
    db=new CatalogDB(dir,{sqliteCacheMb:8});db.importUrls(['https://www.pragmaticplay.fun/en/slots/candy-rush/']);const root=db.nextQueued();db.claim(root.id);db.ready(root.id,{capture_file:'/tmp/fake.jpg',capture:{state:'BASE'}});
    const liveId=db.commit(root.id,[{x:.2,y:.3,kind:'buy'}]).children[0].taskId;db.claim(liveId);db.ready(liveId,{capture_file:'/tmp/live.jpg',capture:{state:'BASE',sessionId:'secret'}});
    const storage={value:null,getItem(){return this.value;},setItem(key,value){this.value=value;}};
    const drafts=new AnnotationState({storage,catalogId:'test-catalog'});drafts.mergeQueue(db.listReady().map(item=>({...item,live:true})));drafts.addMark({x:.2,y:.3,kind:'continue',label:''});
    db.close();db=new CatalogDB(dir,{sqliteCacheMb:8});assert.equal(db.getTask(liveId).status,'blocked','updated backend must block lost LIVE state after restart');
    const h=await harness({storage,initialQueue:{items:[],problems:[],recoveries:[]},details:new Map([[liveId,{task:{...db.getTask(liveId),live:false},marks:db.marksForTask(liveId)}]])});
    try{
      assert.ok(h.calls.some(call=>call.url===`/api/tasks/${liveId}`));assert.equal(h.nodes.get('pins').children.length,1);assert.equal(h.nodes.get('save-btn').disabled,true);assert.equal(h.nodes.get('undo-btn').disabled,true);assert.match(h.nodes.get('hint').textContent,/LIVE_SESSION_LOST/);
      await h.key('KeyN');assert.equal(h.saves.length,0);assert.equal(storage.value.includes('secret'),false);
    }finally{h.close();}
  }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});

test('actual app uses catalog and capture image versions and requires explicit acceptance of changed coordinates',async()=>{
  const first='2026-10-18T01:00:00.000Z',second='2026-10-18T02:00:00.000Z';const firstPhoto={...photo(1),capture:{state:'BASE',capturedAt:first}};
  const h=await harness({initialQueue:{items:[firstPhoto,photo(2)],problems:[],recoveries:[]},settings:{catalogId:'catalog-A'}});try{
    const original=h.nodes.get('shot').getAttribute('src');assert.equal(new URL(original,'http://local').searchParams.get('catalog'),'catalog-A');assert.equal(new URL(original,'http://local').searchParams.get('capture'),first);
    await h.click('image-wrap');await h.row('photo-2').emit('click');await tick();await h.click('image-wrap');
    h.setQueue({items:[{...firstPhoto,capture:{state:'BASE',capturedAt:second}},photo(2)],problems:[],recoveries:[]});await h.click('refresh-btn');await h.row('photo-1').emit('click');await tick();
    assert.notEqual(h.nodes.get('shot').getAttribute('src'),original);assert.ok(h.imageSources.includes(h.nodes.get('shot').getAttribute('src')),'preloader must fetch the changed capture version');assert.equal(h.nodes.get('pins').children.length,1);assert.equal(h.nodes.get('save-btn').disabled,true);assert.equal(h.nodes.get('new-capture-btn').hidden,false);assert.match(h.nodes.get('hint').textContent,/captura cambió/);
    await h.click('new-capture-btn');assert.equal(h.nodes.get('pins').children.length,0);assert.equal(h.nodes.get('save-btn').disabled,false);await h.row('photo-2').emit('click');await tick();assert.equal(h.nodes.get('pins').children.length,1);
  }finally{h.close();}
  const other=await harness({initialQueue:{items:[firstPhoto],problems:[],recoveries:[]},settings:{catalogId:'catalog-B'}});try{assert.equal(new URL(other.nodes.get('shot').getAttribute('src'),'http://local').searchParams.get('catalog'),'catalog-B');}finally{other.close();}
});

test('unavailable catalog settings use in-memory drafts and never read unscoped local data',async()=>{
  let reads=0,writes=0;const h=await harness({settings:Error('settings offline'),storage:{getItem(){reads++;return null;},setItem(){writes++;}}});try{
    await h.click('image-wrap');assert.equal(h.nodes.get('pins').children.length,1);assert.equal(reads,0);assert.equal(writes,0);assert.equal(h.nodes.get('draft-warning').hidden,false);assert.match(h.nodes.get('draft-warning').textContent,/catálogo/);
  }finally{h.close();}
});

test('an unreadable successful HTTP response remains unconfirmed and retries the original marks',async()=>{
  const h=await harness();try{
    await h.click('image-wrap');await h.key('KeyN');await h.click('image-wrap');h.saves[0].resolve({ok:true,status:200,json:async()=>{throw Error('truncated response');}});await tick();
    assert.ok(h.row('photo-1'),'a malformed acknowledgement cannot retire the photo');assert.equal(h.nodes.get('previous-btn').disabled,true);assert.equal(h.nodes.get('pins').children.length,1);
    await h.row('photo-1').emit('click');await tick();assert.equal(h.nodes.get('undo-btn').disabled,true);await h.key('KeyN');assert.deepEqual(h.saves[1].body,h.saves[0].body);h.saves[1].resolve(response(true,{}));await tick();
  }finally{h.close();}
});

test('an older rejection confirmation cannot unlock a later network-failed retry',async()=>{
  const h=await harness();try{
    let confirmOld;h.details.set(1,new Promise(resolve=>{confirmOld=resolve;}));
    await h.click('image-wrap');await h.key('KeyN');await h.click('image-wrap');
    h.saves[0].resolve(response(false,{error:'first attempt rejected'}));await tick();
    assert.ok(h.calls.some(call=>call.url==='/api/tasks/1'),'first rejection starts its delayed confirmation');
    await h.row('photo-1').emit('click');await tick();await h.key('KeyN');assert.deepEqual(h.saves[1].body,h.saves[0].body);
    h.saves[1].reject(new TypeError('retry response lost'));await tick();
    confirmOld({task:photo(1),marks:[]});await tick();
    assert.match(h.nodes.get('game-subtitle').textContent,/Foto #2/);assert.equal(h.nodes.get('pins').children.length,1);
    await h.row('photo-1').emit('click');await tick();assert.equal(h.nodes.get('undo-btn').disabled,true,'old confirmation must not unlock the newer uncertain request');
    await h.click('image-wrap');await h.click('clear-btn');assert.equal(h.nodes.get('pins').children.length,1);
    await h.key('KeyN');assert.deepEqual(h.saves[2].body,h.saves[1].body,'next retry must preserve the later attempt payload');
    assert.match(h.nodes.get('game-subtitle').textContent,/Foto #2/);assert.equal(h.nodes.get('pins').children.length,1);h.saves[2].resolve(response(true,{}));await tick();
  }finally{h.close();}
});
