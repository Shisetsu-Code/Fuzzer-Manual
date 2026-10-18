import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';import fs from 'node:fs';import path from 'node:path';
import {CatalogDB} from '../src/db.js';
import {Scheduler} from '../src/scheduler.js';
import {ImageCache} from '../src/cache.js';
const A='https://www.pragmaticplay.fun/en/slots/candy-rush/';
test('scheduler calls browser adapter, persists snapshot, emits progress',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-sched-'));const db=new CatalogDB(dir,{sqliteCacheMb:8});
  try{db.importUrls([A]);db.setSetting('paused',false);
    let calls=0;const browser={canPrepare:()=>true,liveCount:()=>0,config:{maxLive:4},metrics:{},async prepare(task){calls++;return {file:path.join(dir,'fake.jpg'),capture:{state:'BASE'}};}};
    const scheduler=new Scheduler({db,browser,cache:new ImageCache(16),workers:1});
    scheduler.pump();
    for(let i=0;i<100&&!(db.stats().tasks.ready);i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(calls,1);assert.equal(db.stats().tasks.ready,1);scheduler.stop();
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
