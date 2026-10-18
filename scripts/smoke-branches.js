// Real DEMO-only smoke: select observed purchase OPTIONS; stop before confirming a wager.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CatalogDB} from '../src/db.js';
import {BrowserEngine} from '../src/browser.js';
import {loadConfig,demoUrl} from '../src/config.js';
import {safeEndpoint,sanitizedFields} from '../src/trace.js';

// Export only bounded runtime observations: no frame query, session ID, free text or raw errors.
export function sanitizedObservation(result){
  const capture=result.capture||{};
  const fields=value=>sanitizedFields(JSON.stringify(value||{}));
  const controls=(capture.controls||[]).slice(0,2000).flatMap(c=>{
    if(typeof c.path!=='string'||c.path.length>2048||!/^[/a-z0-9_ .():#-]+$/i.test(c.path))return [];
    const h=c.hit;
    const hit=h&&['x','y','w','h'].every(k=>Number.isFinite(h[k]))?{x:h.x,y:h.y,w:h.w,h:h.h}:null;
    return [{path:c.path,hit}];
  });
  const network=(capture.network||[]).slice(-25).flatMap(e=>{
    const endpoint=safeEndpoint(e.endpoint);if(!endpoint)return [];
    return [{endpoint,method:['GET','POST'].includes(e.method)?e.method:null,
      action:typeof e.action==='string'&&/^[a-z][a-z0-9_]{0,63}$/i.test(e.action)?e.action:null,
      status:Number.isInteger(e.status)?e.status:null,request:fields(e.request),response:fields(e.response)}];
  });
  return {state:typeof capture.state==='string'&&/^[A-Z_]{1,40}$/.test(capture.state)?capture.state:'UNKNOWN',
    screenshot:result.file?path.basename(result.file):null,controls,network};
}

// All preparations in a batch start before waiting for any one to complete. Keep their
// contexts until all settle so liveCount() can prove the retained occupancy, not just intent.
export async function runIndependentBranches({browser,db,children,maxLive,evidence={},onObservation=()=>{}}){
  if(!Number.isInteger(maxLive)||maxLive<1)throw Error('Invalid smoke capacity');
  Object.assign(evidence,{maxLive,peak:0,batches:[],branches:[],samples:[]});
  let capacityViolation=false;
  const sample=(stage,ids)=>{
    const count=browser.liveCount();
    evidence.samples.push({stage,taskIds:ids,count});
    evidence.peak=Math.max(evidence.peak,count);
    if(!Number.isInteger(count)||count<0||count>maxLive)capacityViolation=true;
    return count;
  };
  if(sample('before',[])!==0)throw Error('Smoke requires zero initial retained occupancy');
  for(let offset=0;offset<children.length;offset+=maxLive){
    const batch=children.slice(offset,offset+maxLive),ids=batch.map(c=>c.taskId);
    let failure=null;
    try{
      const pending=batch.map(async child=>{
        const task=db.getTask(child.taskId);
        if(!db.claim(task.id))throw Error('Branch claim failed');
        const preparation=browser.prepare(task);
        sample('started',[task.id]);
        const result=await preparation;
        db.ready(task.id,{capture_file:result.file,capture:result.capture});
        const observation={id:task.id,...sanitizedObservation(result)};
        evidence.branches.push(observation);onObservation(observation);
        sample('prepared',[task.id]);
        return result;
      });
      const outcomes=await Promise.allSettled(pending);
      const held=sample('held',ids);
      evidence.batches.push({taskIds:ids,held,prepared:outcomes.filter(x=>x.status==='fulfilled').length});
      if(capacityViolation)throw Error('Reported occupancy exceeded smoke capacity');
      if(outcomes.some(x=>x.status==='rejected'))throw Error('Independent branch preparation failed');
      if(held!==batch.length)throw Error('Expected every prepared branch to remain held in a retained context');
    }catch(error){failure=error;}
    finally{
      // A rejected prepare may still own a recoverable session. Wait for every sibling
      // above before release so backend active-work guards cannot conceal a leak.
      const releases=await Promise.allSettled(ids.map(id=>browser.release(id)));
      const remaining=sample('released',ids);
      if(releases.some(x=>x.status==='rejected'))failure=new Error('Smoke context release failed',{cause:failure});
      else if(remaining!==0)failure=new Error('Retained occupancy remained after release',{cause:failure});
    }
    if(failure)throw failure;
  }
  return evidence;
}

async function main(){
  const url=demoUrl(process.argv[2]||'https://www.pragmaticplay.fun/en/slots/candy-rush/');
  const cfg=loadConfig();
  cfg.saveHar=false;
  cfg.dataDir=path.resolve(process.env.DATA_DIR||path.join(os.tmpdir(),'fuzzer-manual-branches'));
  const sourceSha=(process.env.GITHUB_SHA||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()).toLowerCase();
  if(!/^[a-f0-9]{40}$/.test(sourceSha))throw Error('An exact source revision is required for smoke diagnostics');
  const diagnosticDir=path.join(cfg.dataDir,'diagnostics',sourceSha);
  fs.mkdirSync(diagnosticDir,{recursive:true});
  const diagnostics={sourceSha,game:url,probe:'purchase-options-to-confirmation',status:'incomplete',
    fullBonus:{status:'not-attempted',reason:'No uniquely observed confirmation and bonus-continuation targets are available.'},
    concurrency:{},root:null};
  const save=()=>fs.writeFileSync(path.join(diagnosticDir,'branches.json'),JSON.stringify(diagnostics,null,2)+'\n');
  const db=new CatalogDB(cfg.dataDir,{sqliteCacheMb:cfg.sqliteCacheMb});
  const browser=new BrowserEngine(cfg,db);
  let root;
  try{
    db.importUrls([url]);
    root=db.db.prepare('SELECT t.*,g.url,g.slug FROM tasks t JOIN games g ON t.game_id=g.id WHERE t.depth=0 LIMIT 1').get();
    if(root.status==='queued')db.claim(root.id);
    const first=await browser.prepare(root);
    db.ready(root.id,{capture_file:first.file,capture:first.capture});
    diagnostics.root={id:root.id,...sanitizedObservation(first)};save();
    if(first.capture.state!=='BUY_MENU')throw Error('Expected BUY_MENU root');
    const options=first.capture.controls.filter(c=>c.hit&&/\/PurchaseWindow\/content\/Options\/Option\d+\/content\/ColliderHolder\/Collider$/i.test(c.path));
    if(options.length<3)throw Error('Expected at least three observed purchase options');
    const marks=options.slice(0,4).map((o,i)=>({x:o.hit.x+o.hit.w/2,y:o.hit.y+o.hit.h/2,kind:'buy',label:`Observed option ${i+1}`}));
    const batch=db.commit(root.id,marks);
    await runIndependentBranches({browser,db,children:batch.children,maxLive:cfg.maxLive,
      evidence:diagnostics.concurrency,onObservation:save});
    const branches=diagnostics.concurrency.branches;
    if(branches.length<3||branches.some(x=>x.state!=='CONFIRM'))throw Error('Observed purchase options did not all reach CONFIRM');
    if(cfg.maxLive>1&&diagnostics.concurrency.peak<2)throw Error('Concurrent retained occupancy was not demonstrated');
    diagnostics.status='passed';
  }catch(error){
    // Browser failures can contain navigated URLs. Persist an error class/code only.
    diagnostics.error=typeof error.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code)?error.code:'SMOKE_INCOMPLETE';
    process.exitCode=1;
  }finally{
    try{if(root)await browser.release(root.id);}
    catch{diagnostics.status='incomplete';diagnostics.cleanupError='ROOT_RELEASE_FAILED';process.exitCode=1;}
    try{await browser.stop();}
    catch{diagnostics.status='incomplete';diagnostics.cleanupError='BROWSER_STOP_FAILED';process.exitCode=1;}
    finally{
      diagnostics.metrics={clicks:browser.metrics.clicks,sessionsOpened:browser.metrics.sessionsOpened,
        finalOccupancy:browser.liveCount()};
      if(diagnostics.metrics.finalOccupancy!==0){diagnostics.status='incomplete';process.exitCode=1;}
      db.close();save();
    }
  }
  console.log(JSON.stringify(diagnostics,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
