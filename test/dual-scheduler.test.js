import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';import fs from 'node:fs';import path from 'node:path';
import {CatalogDB} from '../src/db.js';
import {Scheduler} from '../src/scheduler.js';
import {ImageCache} from '../src/cache.js';

test('2 discovery + 4 branch slots; switches to 1 + 5 on operator activity; borrows idle slots',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-dual-'));
  const db=new CatalogDB(dir,{sqliteCacheMb:8});
  try{
    const urls=Array.from({length:10},(_,i)=>`https://www.pragmaticplay.fun/en/slots/test-${i}/`);
    db.importUrls(urls);
    for(let i=0;i<2;i++){
      const root=db.nextQueued();db.claim(root.id);db.ready(root.id,{capture_file:path.join(dir,'shot.jpg'),capture:{state:'BUY_MENU'}});
      db.commit(root.id,Array.from({length:4},(_,n)=>({x:(n+1)/5,y:.5,kind:'navigate'})));
    }
    const resolvers=new Map();
    const browser={canPrepare:()=>true,liveCount:()=>0,config:{maxLive:4},metrics:{},
      prepare(task){return new Promise(resolve=>resolvers.set(task.id,()=>resolve({file:path.join(dir,'shot.jpg'),capture:{state:'BASE'}})));}};
    db.setSetting('paused',false);
    const scheduler=new Scheduler({db,browser,cache:new ImageCache(64),
      discoveryWorkers:2,branchWorkers:4,workers:6});
    assert.deepEqual(scheduler.allocation(),{discovery:2,branches:4,adaptive:true,catalogerActive:false});
    scheduler.pump();
    assert.equal(scheduler.active.size,6);
    assert.equal(scheduler.status().allocation.activeDiscovery,2);
    assert.equal(scheduler.status().allocation.activeBranches,4);
    scheduler.noteActivity(true);
    assert.equal(scheduler.allocation().discovery,1);
    assert.equal(scheduler.allocation().branches,5);
    scheduler.stop();for(const release of resolvers.values())release();
    assert.equal(await scheduler.drain(2000),true);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
