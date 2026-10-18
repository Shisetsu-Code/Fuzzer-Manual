import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {CatalogDB} from '../src/db.js';
import {ImageCache} from '../src/cache.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fuzzer-manual-bench-'));
const db=new CatalogDB(dir,{sqliteCacheMb:256});
try{
  const N=1000,urls=Array.from({length:N},(_,i)=>`https://www.pragmaticplay.fun/en/slots/test-game-${i}/`);
  let t=performance.now();db.importUrls(urls);const imported=performance.now()-t;
  t=performance.now();for(let i=0;i<N;i++){
    const task=db.db.prepare("SELECT id FROM tasks WHERE depth=0 AND status='queued' LIMIT 1").get();db.claim(task.id);
    db.ready(task.id,{capture_file:`${dir}/shot-${i}.jpg`,capture:{state:'BUY_MENU'}});
    db.commit(task.id,[{x:.2,y:.25,kind:'buy'},{x:.8,y:.25,kind:'buy'},{x:.2,y:.75,kind:'buy'},{x:.8,y:.75,kind:'buy'}]);
  }
  const forked=performance.now()-t;
  const cache=new ImageCache(100*1024*1024);
  t=performance.now();for(let i=0;i<N;i++)cache.put(`snap-${i}`,Buffer.alloc(64*1024));
  const cached=performance.now()-t;
  console.log(JSON.stringify({hardware:os.cpus()[0]?.model,platform:process.platform,node:process.version,
    games:N,importMs:Math.round(imported),forkMs:Math.round(forked),createdBranches:4*N,
    ramCacheMs:Math.round(cached),cache:cache.stats()},null,2));
}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
