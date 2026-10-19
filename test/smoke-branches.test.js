import test from 'node:test';
import assert from 'node:assert/strict';

// Importing the smoke must not launch Chromium or touch a catalog.
const smoke=await import('../scripts/smoke-branches.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function fixture({failId,excess=false,retain=true}={}){
  const held=new Set(),started=[],released=[],ready=[];
  let active=0,peakActive=0;
  const browser={liveCount:()=>held.size+(excess?1:0),
    async prepare(task){
      started.push(task.id);held.add(task.id);active++;peakActive=Math.max(peakActive,active);
      await tick();active--;
      if(task.id===failId)throw Object.assign(Error('private URL?token=SECRET'),{code:'CAPTURE_FAILED'});
      if(!retain)held.delete(task.id);
      return {file:`/tmp/shots/${task.id}.jpg`,capture:{state:'CONFIRM',controls:[]}};
    },
    async release(id){assert.equal(active,0,'cleanup waits for all pending preparations');released.push(id);held.delete(id);},
  };
  const db={getTask:id=>({id}),claim:()=>true,ready:(id)=>ready.push(id)};
  return {browser,db,held,started,released,ready,get peakActive(){return peakActive;}};
}

test('independent branches overlap up to capacity and retain each batch until measured',async()=>{
  assert.equal(typeof smoke.runIndependentBranches,'function');
  const f=fixture();
  const result=await smoke.runIndependentBranches({...f,children:[1,2,3].map(taskId=>({taskId})),maxLive:2});
  assert.equal(f.peakActive,2);
  assert.equal(result.peak,2);
  assert.deepEqual(result.batches.map(b=>b.held),[2,1]);
  assert.deepEqual(f.released,[1,2,3]);
  assert.equal(f.held.size,0);
  assert.equal(result.branches.length,3);
});

test('MAX_LIVE=1 serializes independent preparation',async()=>{
  assert.equal(typeof smoke.runIndependentBranches,'function');
  const f=fixture();
  const result=await smoke.runIndependentBranches({...f,children:[1,2,3].map(taskId=>({taskId})),maxLive:1});
  assert.equal(f.peakActive,1);assert.equal(result.peak,1);
  assert.deepEqual(result.batches.map(b=>b.held),[1,1,1]);
});

test('a retained preparation failure releases every attempted context after siblings settle',async()=>{
  assert.equal(typeof smoke.runIndependentBranches,'function');
  const f=fixture({failId:1});
  await assert.rejects(smoke.runIndependentBranches({...f,children:[1,2,3].map(taskId=>({taskId})),maxLive:2}),/preparation failed/i);
  assert.deepEqual(f.started,[1,2]);assert.deepEqual(f.released,[1,2]);
  assert.equal(f.held.size,0);assert.deepEqual(f.ready,[2]);
});

test('reported occupancy over MAX_LIVE fails and still releases contexts',async()=>{
  assert.equal(typeof smoke.runIndependentBranches,'function');
  const f=fixture();
  const count=f.browser.liveCount;
  f.browser.liveCount=()=>count()+(f.started.length?1:0);
  await assert.rejects(smoke.runIndependentBranches({...f,children:[1,2].map(taskId=>({taskId})),maxLive:2}),/occupancy|capacity/i);
  assert.deepEqual(f.released,[1,2]);assert.equal(f.held.size,0);
});

test('missing retained contexts cannot masquerade as a successful concurrency check',async()=>{
  assert.equal(typeof smoke.runIndependentBranches,'function');
  const f=fixture({retain:false});
  await assert.rejects(smoke.runIndependentBranches({...f,children:[{taskId:1},{taskId:2}],maxLive:2}),/held|retained/i);
  assert.deepEqual(f.released,[1,2]);
});

test('cleanup attempts all releases when one disposal fails',async()=>{
  assert.equal(typeof smoke.runIndependentBranches,'function');
  const f=fixture();
  const release=f.browser.release;
  f.browser.release=async id=>{await release(id);if(id===1)throw Error('disposal failed');};
  await assert.rejects(smoke.runIndependentBranches({...f,children:[{taskId:1},{taskId:2}],maxLive:2}),/release failed/i);
  assert.deepEqual(f.released,[1,2]);assert.equal(f.held.size,0);
});

test('diagnostics retain observed runtime paths and allowlisted transport without secrets',()=>{
  assert.equal(typeof smoke.sanitizedObservation,'function');
  const result=smoke.sanitizedObservation({file:'/tmp/shots/shot.jpg',capture:{state:'CONFIRM',sessionId:'SECRET',
    frameUrl:'https://demo.pragmaticplay.net/gs2c/?token=SECRET',
    controls:[{path:'/FeaturePurchase/PurchaseWindow/ConfirmButton',hit:{x:.1,y:.2,w:.3,h:.4},text:'SECRET'},
      {path:'/bad?token=SECRET',hit:{x:0,y:0,w:1,h:1}}],
    network:[{endpoint:'https://demo.pragmaticplay.net/gs2c/ge/v3/gameService?token=SECRET',method:'POST',action:'doSpin',status:200,
      request:{action:'doSpin',pur:'2',token:'SECRET',cookie:'SECRET'},response:{fs:'10',session:'SECRET'}}]}});
  assert.deepEqual(result.controls,[{path:'/FeaturePurchase/PurchaseWindow/ConfirmButton',hit:{x:.1,y:.2,w:.3,h:.4}}]);
  assert.equal(result.screenshot,'shot.jpg');
  assert.equal(result.network[0].endpoint,'https://demo.pragmaticplay.net/gs2c/ge/v3/gameService');
  assert.deepEqual(result.network[0].request,{action:'doSpin',pur:'2'});
  assert.deepEqual(result.network[0].response,{fs:'10'});
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
