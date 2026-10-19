// Local-only Pragmatic DEMO bulk capture. No game purchase or spin is automated.
// Its outputs form a durable, resumable queue for manual visual classification.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const here=path.dirname(fileURLToPath(import.meta.url));
const projectRoot=path.resolve(here,'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const iso=()=>new Date().toISOString();
const validSlug=/^[a-z0-9-]+$/;
const validRun=/^[a-z0-9][a-z0-9-_]{0,75}$/i;
const MAX_RATE=3;

export function parseArgs(argv){
  const opts={rate:3,batch:6,limit:Infinity,retries:2,repo:'Shisetsu-Code/Fuzzer-Manual',branch:'catalog-snapshots',publish:true,
    catalog:path.join(projectRoot,'catalog/pragmatic-play.json'),dataDir:path.resolve(process.env.DATA_DIR||'data'),
    timeoutMs:30000,headless:process.env.HEADLESS==='1'};
  for(const arg of argv){
    if(arg==='--no-publish')opts.publish=false;
    else if(arg==='--publish-only')opts.publishOnly=true;
    else if(arg==='--retry-failed')opts.retryFailed=true;
    else if(arg==='--headless')opts.headless=true;
    else if(arg==='--headed')opts.headless=false;
    else if(arg==='--help')opts.help=true;
    else if(arg==='--dry-run')opts.dryRun=true;
    else {
      const match=/^--([a-z-]+)=(.*)$/.exec(arg);
      if(!match)throw Error(`Unknown argument: ${arg}`);
      const [,key,value]=match;
      if(key==='catalog')opts.catalog=path.resolve(value);
      else if(key==='data-dir')opts.dataDir=path.resolve(value);
      else if(key==='run-id')opts.runId=value;
      else if(key==='repo')opts.repo=value;
      else if(key==='branch')opts.branch=value;
      else if(key==='only')opts.only=value.split(',').filter(Boolean);
      else if(['rate','batch','limit','retries','timeout-ms'].includes(key)){
        const n=Number(value);
        if(!Number.isSafeInteger(n)||n<0)throw Error(`Invalid --${key}: ${value}`);
        opts[key==='timeout-ms'?'timeoutMs':key]=n;
      }else throw Error(`Unknown argument: --${key}`);
    }
  }
  if(opts.rate<1||opts.rate>MAX_RATE)throw Error('Rate must be 1..3 game starts per minute');
  if(opts.batch<1||opts.batch>25)throw Error('Batch must be 1..25');
  if(opts.retries<1||opts.retries>4)throw Error('Retries must be 1..4');
  if(opts.timeoutMs<5000||opts.timeoutMs>120000)throw Error('timeout-ms must be 5000..120000');
  if(!Number.isSafeInteger(opts.limit)&&opts.limit!==Infinity)throw Error('Invalid limit');
  if(!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(opts.repo))throw Error('Invalid GitHub repository');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_/-]*$/.test(opts.branch)||opts.branch.includes('..'))throw Error('Invalid GitHub branch');
  if(opts.runId&&!validRun.test(opts.runId))throw Error('Invalid run-id');
  if(opts.only?.some(slug=>!validSlug.test(slug)))throw Error('Invalid --only slug');
  return opts;
}

export function normalizeCatalog(raw,now=new Date()){
  if(raw?.provider!=='pragmatic'||!Array.isArray(raw.games))throw Error('Invalid Pragmatic catalog');
  const today=now.toISOString().slice(0,10),seen=new Set();
  return raw.games.map(row=>{
    const url=typeof row==='string'?row:row.url;
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||parsed.hostname!=='www.pragmaticplay.fun'||parsed.port||parsed.search||parsed.hash||parsed.username||parsed.password||
      !/^\/en\/slots\/[a-z0-9-]+\/$/.test(parsed.pathname))throw Error(`Unsafe non-DEMO URL: ${url}`);
    const slug=parsed.pathname.split('/')[3];
    if(seen.has(slug))throw Error(`Duplicate game: ${slug}`);seen.add(slug);
    const date=typeof row==='string'?null:row.releaseDate||null;
    const upcoming=(date!=null&&date>today)||(typeof row==='object'&&row.status==='upcoming'&&!date);
    return {url:parsed.href,slug,releaseDate:date,status:upcoming?'upcoming':'available'};
  });
}

async function readJSON(file,fallback){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export async function atomicJSON(file,obj){await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';await fs.writeFile(temp,JSON.stringify(obj,null,2)+'\n');await fs.rename(temp,file);}

// Persist reservations BEFORE navigation. The limiter survives process restarts.
export class StartLimiter{
  constructor(file,{rate=3,clock=()=>Date.now(),sleeper=wait}={}){
    if(!Number.isInteger(rate)||rate<1||rate>3)throw Error('Maximum 3 game starts per minute');
    this.file=file;this.rate=rate;this.clock=clock;this.sleeper=sleeper;
  }
  async reserve(){
    const interval=Math.ceil(60000/this.rate)+100;
    while(true){
      const doc=await readJSON(this.file,{starts:[]});
      const now=this.clock();
      const starts=(doc.starts||[]).filter(n=>Number.isFinite(n)&&n>now-120000&&n<=now).sort((a,b)=>a-b);
      const last=starts.at(-1)||0;
      const windowStart=starts.length>=3?starts.at(-3):0;
      const next=Math.max(last+interval,windowStart+60001);
      if(last&&now<next){await this.sleeper(Math.max(1,next-now));continue;}
      starts.push(now);
      await atomicJSON(this.file,{starts,updatedAt:iso()});
      return now;
    }
  }
}

export async function lockRun(dataDir){
  await fs.mkdir(dataDir,{recursive:true});
  const file=path.join(dataDir,'.catalog-batch.lock');
  for(let pass=0;pass<2;pass++){
    try{const h=await fs.open(file,'wx');try{await h.writeFile(JSON.stringify({pid:process.pid,at:iso()}));}finally{await h.close();}
      return async()=>{await fs.unlink(file).catch(()=>{});};
    }catch(e){
      if(e.code!=='EEXIST')throw e;
      const previous=await readJSON(file,null).catch(()=>null);
      if(previous?.pid&&Number.isSafeInteger(previous.pid)){
        try{process.kill(previous.pid,0);throw Error(`Capture already running (PID ${previous.pid})`);}
        catch(err){if(err.message.startsWith('Capture already')||err.code==='EPERM')throw err;if(err.code!=='ESRCH')throw err;}
      }else throw Error('Unknown capture lock; inspect .catalog-batch.lock before removing it');
      await fs.unlink(file).catch(()=>{});
    }
  }
  throw Error('Unable to acquire capture lock');
}

// We intentionally use only the existing known-intro helper, never a buy-menu heuristic.
export async function waitForBase(engine,session,{timeoutMs=30000,clock=()=>Date.now(),sleeper=wait}={}){
  const end=clock()+timeoutMs;let baseSince=0,last=null,introAttempts=0;
  while(clock()<end){
    const view=await engine.observe(session);last=view;
    if(view.state==='INTRO'){
      baseSince=0;
      if(introAttempts<1){
        introAttempts++;
        const opened=await engine.openKnownIntro(session);
        if(opened.opened){await sleeper(1200);continue;}
      }
    }else if(view.state==='BASE'){
      if(!baseSince)baseSince=clock();
      if(clock()-baseSince>=1600){
        // Some Pragmatic loaders briefly show BASE before a late IntroScreen.
        await sleeper(950);
        const check=await engine.observe(session);last=check;
        if(check.state==='BASE')return {ready:true,view:check,introAttempts};
        baseSince=0;
      }
    }else baseSince=0;
    await sleeper(350);
  }
  return {ready:false,view:last,introAttempts,reason:last?.state==='INTRO'?'INTRO_NEEDS_MANUAL_CLICK':'BASE_NOT_STABLE'};
}

export function safeManifestEntry(item){
  return {slug:item.slug,url:item.url,status:item.status,state:item.state||null,image:item.image||null,metadata:item.metadata||null,
    taskId:item.taskId||null,gameSymbol:item.gameSymbol||null,attempts:item.attempts||0,error:item.error||null,
    capturedAt:item.capturedAt||null};
}
export function makeManifest(catalog,runId){
  return {schemaVersion:1,runId,provider:'pragmatic',source:catalog.source,sourceCapturedAt:catalog.capturedAt,
    total:catalog.games.length,createdAt:iso(),updatedAt:iso(),entries:{},sheets:[]};
}
export function summary(manifest){const counts={ready:0,review:0,failed:0,upcoming:0,pending:0};for(const v of Object.values(manifest.entries)){counts[v.status]=(counts[v.status]||0)+1;}counts.pending=Math.max(0,manifest.total-Object.keys(manifest.entries).length);return counts;}

export async function buildSheets(manifest,outDir){
  // 2x2 contact sheets keep labels and visual controls readable at normal zoom.
  const entries=Object.values(manifest.entries).filter(x=>['ready','review'].includes(x.status)&&x.image&&fss.existsSync(path.join(outDir,x.image)))
    .sort((a,b)=>a.slug.localeCompare(b.slug));
  const sharp=(await import('sharp')).default;
  const newSheets=[];
  const makeLabel=slug=>Buffer.from(`<svg width="780" height="32"><rect width="100%" height="100%" fill="#131722"/><text x="10" y="23" font-size="19" fill="white" font-family="sans-serif">${slug}</text></svg>`);
  for(let i=0;i<entries.length;i+=4){
    const group=entries.slice(i,i+4);const file=`sheets/sheet-${String(i/4+1).padStart(4,'0')}.jpg`;
    const target=path.join(outDir,file);
    const old=manifest.sheets.find(x=>x.file===file);
    if(old&&JSON.stringify(old.slugs)===JSON.stringify(group.map(x=>x.slug))&&fss.existsSync(target)){
      newSheets.push(old);continue;
    }
    const layers=[];
    for(let j=0;j<group.length;j++){
      const posX=(j%2)*780,posY=Math.floor(j/2)*472;
      const image=await sharp(path.join(outDir,group[j].image)).resize(780,440,{fit:'contain',background:'#111827'}).jpeg({quality:62}).toBuffer();
      layers.push({input:makeLabel(group[j].slug),left:posX,top:posY});
      layers.push({input:image,left:posX,top:posY+32});
    }
    await fs.mkdir(path.dirname(target),{recursive:true});
    await sharp({create:{width:1560,height:944,channels:3,background:'#111827'}}).composite(layers).jpeg({quality:70}).toFile(target+'.tmp');
    await fs.rename(target+'.tmp',target);
    newSheets.push({file,slugs:group.map(x=>x.slug)});
  }
  manifest.sheets=newSheets;return newSheets;
}

function discoverToken(){
  if(process.env.GH_TOKEN||process.env.GITHUB_TOKEN)return process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  try{return execFileSync('gh',['auth','token'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return '';} }

// The *orphan* catalog-snapshots branch stores images without polluting PR history.
export class GithubPublisher{
  constructor({repo,branch='catalog-snapshots',token,fetchImpl=globalThis.fetch,sleeper=wait}={}){
    if(!token)throw Error('GitHub authentication missing: gh auth login or GH_TOKEN');
    this.repo=repo;this.branch=branch;this.token=token;this.fetch=fetchImpl;this.sleeper=sleeper;
    this.url=`https://api.github.com/repos/${repo}`;
  }
  async api(method,path,body){
    for(let attempt=0;attempt<5;attempt++){
      const response=await this.fetch(this.url+path,{method,headers:{'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',
        'Authorization':`Bearer ${this.token}`,'User-Agent':'fuzzer-manual-local-snapshots',...(body?{'Content-Type':'application/json'}:{})},
        body:body?JSON.stringify(body):undefined});
      let data;try{data=await response.json();}catch{data={};}
      if(response.ok)return data;
      if([429,500,502,503,504].includes(response.status)&&attempt<4){await this.sleeper(1000*2**attempt);continue;}
      const e=Error(`GitHub ${method} ${path} HTTP ${response.status}: ${String(data.message||'request failed').slice(0,170)}`);
      e.status=response.status;throw e;
    }
  }
  async head(){
    try{return await this.api('GET',`/git/ref/heads/${this.branch}`);}catch(e){if(e.status===404)return null;throw e;}
  }
  async ensureBranch(){
    const current=await this.head();if(current)return current;
    const tree=await this.api('POST','/git/trees',{tree:[]});
    const commit=await this.api('POST','/git/commits',{message:'Initialize image-only catalog branch',tree:tree.sha,parents:[]});
    try{await this.api('POST','/git/refs',{ref:`refs/heads/${this.branch}`,sha:commit.sha});}
    catch(e){if(e.status!==422)throw e;}
    return this.head();
  }
  async publish(runId,folder,manifest,entries){
    const blobs=[];
    for(const file of entries){
      const abs=path.resolve(folder,file);
      if(!abs.startsWith(path.resolve(folder)+path.sep))throw Error('Invalid upload path');
      const bytes=await fs.readFile(abs);
      const blob=await this.api('POST','/git/blobs',{content:bytes.toString('base64'),encoding:'base64'});
      blobs.push({path:`runs/${runId}/${file}`,mode:'100644',type:'blob',sha:blob.sha});
    }
    const portable={...manifest,entries:Object.fromEntries(Object.entries(manifest.entries).map(([k,v])=>[k,safeManifestEntry(v)]))};
    const body=JSON.stringify(portable,null,2)+'\n';
    for(let retries=0;retries<4;retries++){
      const ref=await this.ensureBranch();
      const prior=await this.api('GET',`/git/commits/${ref.object.sha}`);
      const tree=await this.api('POST','/git/trees',{base_tree:prior.tree.sha,tree:[...blobs,
        {path:`runs/${runId}/manifest.json`,mode:'100644',type:'blob',content:body},
        {path:'latest.json',mode:'100644',type:'blob',content:JSON.stringify({runId,path:`runs/${runId}/manifest.json`,updatedAt:iso()})+'\n'}]});
      const commit=await this.api('POST','/git/commits',{message:`Catalog ${runId}: ${entries.length} new/updated images`,tree:tree.sha,parents:[ref.object.sha]});
      try{
        await this.api('PATCH',`/git/refs/heads/${this.branch}`,{sha:commit.sha,force:false});
        return {sha:commit.sha,count:entries.length};
      }catch(e){if(![409,422].includes(e.status)||retries===3)throw e;await this.sleeper(600*(retries+1));}
    }
  }
}

async function writeSnapshot({engine,session,task,dir,slug,review=false}){
  const r=await engine.screenshot(session,task.id,{rootMode:'base'});
  const local=`${review?'review':'shots'}/${slug}.jpg`;
  await fs.mkdir(path.dirname(path.join(dir,local)),{recursive:true});
  await fs.copyFile(r.file,path.join(dir,local));
  const meta=`metadata/${slug}.json`;
  await atomicJSON(path.join(dir,meta),{
    schemaVersion:1,slug,taskId:task.id,url:task.url,provider:'pragmatic',state:r.capture.state,
    gameSymbol:r.capture.gameSymbol,controls:r.capture.controls,clip:r.capture.clip,
    viewport:{width:r.capture.width,height:r.capture.height},sessionId:r.capture.sessionId,
    capturedAt:r.capture.capturedAt,network:r.capture.network,
    review,manualClassification:{state:'pending',marks:[]}
  });
  return {capture:r.capture,image:local,metadata:meta};
}

export async function main(argv=process.argv.slice(2)){
  const opts=parseArgs(argv);
  if(opts.help){console.log(`npm run catalog:capture -- [--limit=5] [--only=candy-rush] [--no-publish] [--retry-failed] [--headless]
  [--catalog=catalog/pragmatic-play.json] [--data-dir=data] [--run-id=pragmatic-20261019] [--rate=1..3]
  [--publish-only] [--batch=6] [--repo=Shisetsu-Code/Fuzzer-Manual] [--branch=catalog-snapshots]
Uploads use GH_TOKEN/GITHUB_TOKEN or 'gh auth login'. Never automate purchase/spin.`);return;}
  const catalog=JSON.parse(await fs.readFile(opts.catalog,'utf8'));
  const games=normalizeCatalog(catalog);
  const runId=opts.runId||`pragmatic-${(catalog.capturedAt||iso()).slice(0,10).replaceAll('-','')}`;
  if(!validRun.test(runId))throw Error('Invalid derived run-id');
  const outDir=path.join(opts.dataDir,'catalog-exports',runId),manifestPath=path.join(outDir,'manifest.json');
  let manifest=await readJSON(manifestPath,null)||makeManifest(catalog,runId);
  if(manifest.runId!==runId)throw Error('Run identifier mismatch');
  const selected=games.filter(g=>!opts.only||opts.only.includes(g.slug));
  if(opts.dryRun){console.log(JSON.stringify({runId,catalog:opts.catalog,games:games.length,available:games.filter(g=>g.status==='available').length,
    upcoming:games.filter(g=>g.status==='upcoming').length,selected:selected.length,rate:opts.rate,already:summary(manifest),publish:opts.publish},null,2));return;}
  const unlock=await lockRun(opts.dataDir);
  let db,browser,queuedUnpublished=0;
  let publisher=null;
  const save=async()=>{manifest.updatedAt=iso();await atomicJSON(manifestPath,manifest);};
  const publish=async(force=false)=>{
    if(!publisher)return;
    const pending=Object.values(manifest.entries).filter(x=>x.image&&x.metadata&&!x.publishedAt&&fss.existsSync(path.join(outDir,x.image)));
    if(!force&&pending.length<opts.batch)return;
    await buildSheets(manifest,outDir);
    const files=[...new Set([...pending.flatMap(x=>[x.image,x.metadata]),...manifest.sheets.filter(x=>!x.publishedAt).map(x=>x.file)])];
    try{
      const result=await publisher.publish(runId,outDir,manifest,files);
      for(const row of pending)row.publishedAt=iso();
      for(const sheet of manifest.sheets)sheet.publishedAt=iso();
      queuedUnpublished=0;await save();
      console.log(`Published ${files.length} files, commit ${result.sha.slice(0,12)} https://github.com/${opts.repo}/tree/${opts.branch}/runs/${runId}`);
    }catch(e){console.error('Upload postponed; local files are intact:',e.message);await save();}
  };
  try{
    await fs.mkdir(outDir,{recursive:true});
    if(opts.publish){
      const token=discoverToken();
      if(token)publisher=new GithubPublisher({repo:opts.repo,branch:opts.branch,token});
      else if(opts.publishOnly)throw Error('GitHub not authenticated; run gh auth login or configure GH_TOKEN before --publish-only');
      else console.warn('GitHub not authenticated; screenshots kept locally. Run gh auth login and rerun --publish-only.');
    }
    if(opts.publishOnly){await publish(true);console.log('Publish-only done');return;}
    const {loadConfig}=await import('../src/config.js');
    const {CatalogDB}=await import('../src/db.js');
    const {BrowserEngine}=await import('../src/browser.js');
    const config=loadConfig();config.dataDir=opts.dataDir;config.headless=opts.headless;
    db=new CatalogDB(opts.dataDir,{sqliteCacheMb:config.sqliteCacheMb});
    const available=selected.filter(g=>g.status==='available');
    db.importUrls(available.map(g=>g.url));
    browser=new BrowserEngine(config,db);
    const limiter=new StartLimiter(path.join(opts.dataDir,'catalog-rate.json'),{rate:opts.rate});
    let visited=0;let stop=false;
    const signal=()=>{stop=true;console.log('Stop requested: finishing current game safely...');};
    process.on('SIGINT',signal);process.on('SIGTERM',signal);
    try{
      for(const item of selected){
        if(stop||visited>=opts.limit)break;
        const previous=manifest.entries[item.slug];
        if(item.status==='upcoming'){
          if(!previous){manifest.entries[item.slug]={slug:item.slug,url:item.url,status:'upcoming',releaseDate:item.releaseDate};await save();}
          continue;
        }
        if(previous?.status==='ready'&&previous.image&&fss.existsSync(path.join(outDir,previous.image)))continue;
        const task=db.db.prepare(`SELECT t.*,g.url,g.slug,g.game_symbol,g.provider FROM tasks t JOIN games g ON g.id=t.game_id WHERE g.url=? AND t.depth=0 LIMIT 1`).get(item.url);
        if(!task)throw Error(`No root task found: ${item.slug}`);
        if(task.status==='annotated'||task.status==='skipped'){console.log(`${item.slug}: already reviewed in DB; skipping`);continue;}
        if(task.status==='ready'&&task.capture_file&&fss.existsSync(task.capture_file)){
          const capture=JSON.parse(task.capture_json||'{}');
          const ready=await fs.readFile(task.capture_file);
          const image=`shots/${item.slug}.jpg`;await fs.mkdir(path.dirname(path.join(outDir,image)),{recursive:true});await fs.writeFile(path.join(outDir,image),ready);
          const metadata=`metadata/${item.slug}.json`;
          await atomicJSON(path.join(outDir,metadata),{schemaVersion:1,url:item.url,slug:item.slug,taskId:task.id,...capture,manualClassification:{state:'pending',marks:[]}});
          manifest.entries[item.slug]={slug:item.slug,url:item.url,status:'ready',state:capture.state||'BASE',taskId:task.id,image,metadata,gameSymbol:capture.gameSymbol,capturedAt:capture.capturedAt||iso(),attempts:0};
          await save();queuedUnpublished++;await publish();continue;
        }
        if(task.status!=='queued'){
          if(!opts.retryFailed&&['failed','review'].includes(previous?.status))continue;
          if(opts.retryFailed||['failed','blocked','ready'].includes(task.status)){
            db.db.prepare(`UPDATE tasks SET status='queued',error=NULL,action_state=NULL,updated_at=datetime('now') WHERE id=? AND depth=0 AND status IN ('failed','blocked','ready')`).run(task.id);
          }else{console.log(`${item.slug}: task is ${task.status}, skipping`);continue;}
        }
        visited++;
        for(let attempt=1;attempt<=opts.retries&&!stop;attempt++){
          await limiter.reserve();
          if(stop)break;
          if(!db.claim(task.id))throw Error(`Cannot claim root ${item.slug}`);
          let session=null,exported=null,error=null;
          try{
            session=await browser.fresh(item.url,task);
            const result=await waitForBase(browser,session,{timeoutMs:opts.timeoutMs});
            exported=await writeSnapshot({engine:browser,session,task,dir:outDir,slug:item.slug,review:!result.ready});
            const ready=result.ready&&exported.capture.state==='BASE';
            if(ready)db.ready(task.id,{capture_file:path.join(opts.dataDir,'shots',`task-${task.id}.jpg`),capture:exported.capture});
            else db.fail(task.id,'failed',result.reason||`NOT_BASE_${exported.capture.state}`);
            manifest.entries[item.slug]={slug:item.slug,url:item.url,status:ready?'ready':'review',state:exported.capture.state,
              taskId:task.id,image:exported.image,metadata:exported.metadata,gameSymbol:exported.capture.gameSymbol,
              attempts:attempt,capturedAt:exported.capture.capturedAt,error:ready?null:result.reason};
            console.log(`[${visited}] ${item.slug}: ${ready?'READY':'NEEDS_REVIEW'} ${exported.capture.state}`);
            await save();queuedUnpublished++;await publish();
            break;
          }catch(e){
            error=e;
            db.fail(task.id,'failed',String(e.message||e));
            console.error(`[${visited}] ${item.slug} attempt ${attempt}: ${String(e.message||e).slice(0,160)}`);
            manifest.entries[item.slug]={slug:item.slug,url:item.url,status:'failed',taskId:task.id,attempts:attempt,error:String(e.message||e).slice(0,400)};
            await save();
          }finally{if(session)await browser.dispose(session).catch(()=>{});}
          if(error&&attempt<opts.retries&&!stop){db.db.prepare(`UPDATE tasks SET status='queued',error=NULL,action_state=NULL WHERE id=? AND depth=0 AND status='failed'`).run(task.id);}
        }
      }
    }finally{process.off('SIGINT',signal);process.off('SIGTERM',signal);}
    await publish(true);
    console.log('RESULT '+JSON.stringify({runId,visited,...summary(manifest),local:outDir,github:publisher?`https://github.com/${opts.repo}/tree/${opts.branch}/runs/${runId}`:null}));
  }finally{
    await browser?.stop().catch(()=>{});db?.close();await unlock();
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
}
