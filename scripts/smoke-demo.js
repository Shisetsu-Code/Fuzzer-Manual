import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {CatalogDB} from '../src/db.js';import {BrowserEngine} from '../src/browser.js';
import {loadConfig,demoUrl} from '../src/config.js';
const url=demoUrl(process.argv[2]||'https://www.pragmaticplay.fun/en/slots/candy-rush/');
const cfg=loadConfig();cfg.dataDir=path.resolve(process.env.DATA_DIR||path.join(os.tmpdir(),'fuzzer-manual-smoke'));
fs.mkdirSync(cfg.dataDir,{recursive:true});const db=new CatalogDB(cfg.dataDir,{sqliteCacheMb:cfg.sqliteCacheMb});
const browser=new BrowserEngine(cfg,db);
try{
  db.importUrls([url]);const task=db.db.prepare("SELECT t.*,g.url,g.slug FROM tasks t JOIN games g ON t.game_id=g.id WHERE t.depth=0 LIMIT 1").get();
  const result=await browser.prepare(task);
  console.log(JSON.stringify({image:result.file,state:result.capture.state,controls:result.capture.controls.length,controlPaths:result.capture.controls.filter(c=>c.hit).slice(0,15).map(c=>c.path),
    gpuRenderer:browser.metrics.lastRenderer,clicks:browser.metrics.clicks,bytes:result.capture.bytes},null,2));
  if(result.capture.controls.length<1)throw Error('DEMO_RUNTIME_NOT_OBSERVED: screenshot was saved but no active runtime controls were found');
}finally{await browser.stop();db.close();}
