import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './config.js';
import {CatalogDB} from './db.js';
import {ImageCache} from './cache.js';
import {BrowserEngine} from './browser.js';
import {Scheduler} from './scheduler.js';

const config=loadConfig(),db=new CatalogDB(config.dataDir,{sqliteCacheMb:config.sqliteCacheMb});
const cache=new ImageCache(config.imageCacheMb*1024*1024);
const browser=new BrowserEngine(config,db);
const scheduler=new Scheduler({db,browser,cache,workers:config.workers,discoveryWorkers:config.discoveryWorkers,
  branchWorkers:config.branchWorkers,adaptiveWorkers:config.adaptiveWorkers,previewCount:config.previewCount});
const here=path.dirname(fileURLToPath(import.meta.url));
const publicDir=path.resolve(here,'../public');
const staticPaths=new Map([['/', ['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);

function json(res,status,body){const content=Buffer.from(JSON.stringify(body));res.writeHead(status,{
  'Content-Type':'application/json; charset=utf-8','Content-Length':content.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(content);}
function error(res,e){const msg=String(e.message||e);const status=/not found/i.test(msg)?404:/already cataloged|not ready/i.test(msg)?409:400;json(res,status,{error:msg});}
async function receive(req){
  const parts=[];let size=0;
  for await(const part of req){size+=part.length;if(size>4*1024*1024)throw Error('Request exceeds 4 MiB');parts.push(part);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Error('Invalid JSON');}
}
async function handler(req,res){
  try{
    const u=new URL(req.url,'http://localhost');const p=u.pathname;
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if(req.method==='GET'&&staticPaths.has(p)){
      const [file,mime]=staticPaths.get(p);const content=await fs.readFile(path.join(publicDir,file));
      res.writeHead(200,{'Content-Type':mime,'Content-Length':content.length,'Cache-Control':'no-cache'});res.end(content);return;
    }
    if(req.method==='GET'&&p==='/api/status')return json(res,200,scheduler.status());
    if(req.method==='GET'&&p==='/api/queue'){
      const limit=Math.min(250,Math.max(1,Number(u.searchParams.get('limit')||100)||100));
      return json(res,200,{items:db.listReady(limit).map(item=>({...item,live:browser.hasLive(item.id)})),problems:db.listProblems(30)});
    }
    const image=p.match(/^\/api\/images\/(\d+)$/);
    if(req.method==='GET'&&image){
      const task=db.getTask(Number(image[1]));if(!task?.capture_file)return json(res,404,{error:'Image not found'});
      const dir=path.resolve(config.dataDir,'shots');const target=path.resolve(task.capture_file);
      if(!target.startsWith(dir+path.sep))return json(res,403,{error:'Outside snapshot directory'});
      const bytes=await cache.load(target);
      res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':bytes.length,'Cache-Control':'private, max-age=31536000, immutable'});res.end(bytes);return;
    }
    const trace=p.match(/^\/api\/tasks\/(\d+)\/trace$/);
    if(req.method==='GET'&&trace){
      const id=Number(trace[1]);if(!db.getTask(id))return json(res,404,{error:'Unknown task'});
      const limit=Math.min(500,Math.max(1,Number(u.searchParams.get('limit')||100)||100));
      return json(res,200,{taskId:id,events:db.eventsForTask(id,limit)});
    }
    const game=p.match(/^\/api\/games\/(\d+)(?:\/export)?$/);
    if(req.method==='GET'&&game){
      const gameId=Number(game[1]);const detail=db.gameDetail(gameId);
      return detail?json(res,200,detail):json(res,404,{error:'Unknown game'});
    }
    const task=p.match(/^\/api\/tasks\/(\d+)$/);
    if(req.method==='GET'&&task){const id=Number(task[1]),item=db.getTask(id);return item?json(res,200,{task:item,marks:db.marksForTask(id),lineage:db.lineage(id)}):json(res,404,{error:'Unknown task'});}
    if(req.method==='POST'&&p==='/api/import'){
      const body=await receive(req);const list=Array.isArray(body.urls)?body.urls:String(body.urls||'').split(/[\r\n]+/);
      const imported=db.importUrls(list);scheduler.pump();return json(res,200,imported);
    }
    if(req.method==='POST'&&p==='/api/activity'){
      const body=await receive(req);scheduler.noteActivity(body.active===true);
      return json(res,200,{allocation:scheduler.allocation()});
    }
    if(req.method==='POST'&&p==='/api/run'){
      const body=await receive(req);scheduler.setPause(!Boolean(body.running));return json(res,200,{paused:scheduler.paused});
    }
    const commit=p.match(/^\/api\/tasks\/(\d+)\/commit$/);
    if(req.method==='POST'&&commit){
      const id=Number(commit[1]);const data=await receive(req);
      if(browser.hasLive(id)&&data.marks?.length>1)throw Error('A live RNG session cannot be forked into multiple identical states; select one live action');
      const result=db.commit(id,data.marks);scheduler.noteActivity(true);
      if(result.marks===0)await browser.release(id);
      scheduler.pump();return json(res,200,result);
    }
    const release=p.match(/^\/api\/tasks\/(\d+)\/release$/);
    if(req.method==='POST'&&release){await browser.release(Number(release[1]));return json(res,200,{ok:true});}
    if(req.method==='GET'&&p==='/api/settings')return json(res,200,{hotkeys:db.getSetting('hotkeys',null)});
    if(req.method==='POST'&&p==='/api/settings'){
      const body=await receive(req);
      if(body.hotkeys){const h=body.hotkeys;
        if(!h||typeof h!=='object'||Object.keys(h).length>12||Object.values(h).some(s=>typeof s!=='string'||s.length>30))throw Error('Invalid hotkeys');
        db.setSetting('hotkeys',h);
      }
      return json(res,200,{ok:true});
    }
    return json(res,404,{error:'Not found'});
  }catch(e){error(res,e);}
}
const server=http.createServer(handler);
server.headersTimeout=10000;server.requestTimeout=60000;
server.listen(config.port,config.host,()=>{
  console.log(`Fuzzer Manual: http://${config.host}:${config.port}`);
  console.log(`Data: ${config.dataDir}, discovery=${config.discoveryWorkers}, branches=${config.branchWorkers}, adaptive=${config.adaptiveWorkers}, GPU=${config.gpuMode}, live=${config.maxLive}`);
  scheduler.start();
});
async function close(){scheduler.setPause(true);scheduler.stop();server.close();await scheduler.drain();await browser.stop();db.close();}
let shuttingDown=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(!shuttingDown){shuttingDown=true;close().finally(()=>process.exit(0));}});
