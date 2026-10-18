// Real DEMO-only smoke: select multiple purchase OPTIONS but do not confirm a wager.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CatalogDB} from '../src/db.js';
import {BrowserEngine} from '../src/browser.js';
import {loadConfig,demoUrl} from '../src/config.js';

const url=demoUrl(process.argv[2]||'https://www.pragmaticplay.fun/en/slots/candy-rush/');
const cfg=loadConfig();cfg.dataDir=path.resolve(process.env.DATA_DIR||path.join(os.tmpdir(),'fuzzer-manual-branches'));
fs.mkdirSync(cfg.dataDir,{recursive:true});const db=new CatalogDB(cfg.dataDir,{sqliteCacheMb:cfg.sqliteCacheMb});
const browser=new BrowserEngine(cfg,db);
try{
  db.importUrls([url]);
  const root=db.db.prepare("SELECT t.*,g.url,g.slug FROM tasks t JOIN games g ON t.game_id=g.id WHERE t.depth=0 LIMIT 1").get();
  if(root.status==='queued')db.claim(root.id);
  const first=await browser.prepare(root);
  db.ready(root.id,{capture_file:first.file,capture:first.capture});
  if(first.capture.state!=='BUY_MENU')throw Error(`Menu did not open: ${first.capture.state}`);
  const options=first.capture.controls.filter(c=>c.hit&&/\/PurchaseWindow\/content\/Options\/Option\d+\/content\/ColliderHolder\/Collider$/i.test(c.path));
  if(options.length<3)throw Error(`Expected at least 3 observed purchase options, got ${options.length}`);
  const marks=options.slice(0,4).map((o,i)=>({x:o.hit.x+o.hit.w/2,y:o.hit.y+o.hit.h/2,kind:'buy',label:`Observed option ${i+1}`}));
  const batch=db.commit(root.id,marks);
  const branches=[];
  for(const child of batch.children){
    const task=db.getTask(child.taskId);
    if(!db.claim(task.id))throw Error(`Could not claim branch ${task.id}`);
    const result=await browser.prepare(task);
    db.ready(task.id,{capture_file:result.file,capture:result.capture});
    branches.push({id:task.id,state:result.capture.state,screenshot:result.file});
    await browser.release(task.id);
  }
  console.log(JSON.stringify({rootState:first.capture.state,branches,game:url,clicks:browser.metrics.clicks,
    sessions:browser.metrics.sessionsOpened,saved:db.stats()},null,2));
  if(branches.length<3||branches.some(x=>x.state!=='CONFIRM'))throw Error('Not all observed purchase options reached CONFIRM in independent DEMO contexts');
}finally{await browser.stop();db.close();}
