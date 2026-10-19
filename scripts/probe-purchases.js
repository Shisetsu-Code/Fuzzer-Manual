// Live public-DEMO probe. Production BrowserEngine logic is imported unchanged.
// The default phase inventories observed menu choices and stops at confirmations.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CatalogDB} from '../src/db.js';
import {BrowserEngine} from '../src/browser.js';
import {loadConfig,demoUrl,gameSlug} from '../src/config.js';
import {safeEndpoint,sanitizedFields} from '../src/trace.js';

const PURCHASE=/FeaturePurchase|BuyFeature|PurchaseWindow|FSPurchase|BuyBonus|BuyFreeSpins|GameFeatures/i;
const WINDOW=/(?:PurchaseWindow|FSPurchaseWindow|BuyFeatureWindow|BuyBonusWindow|GameFeaturesWindow)(?:\/|$)/i;
const NEGATIVE=/(?:^|[/_ -])(?:cancel|close|back|decline|reject|no|info|help|rules|settings|minus|plus)(?:button|btn|[/_ -]|$)|(?:button|btn)_?(?:cancel|close|back|no|info|help|minus|plus)(?:[/_ -]|$)/i;
const POSITIVE=/(?:^|[/_ -])(?:confirm|yes|accept|ok|buy|purchase)(?:button|btn|[/_ -]|$)|(?:button|btn)_?(?:confirm|yes|accept|ok|buy|purchase)(?:[/_ -]|$)/i;
const CONFIRM_WORD=/(?:^|[/_ -])(?:confirm|yes|accept|ok)(?:button|btn|[/_ -]|$)|(?:button|btn)_?(?:confirm|yes|accept|ok)(?:[/_ -]|$)/i;
const fields=value=>sanitizedFields(JSON.stringify(value||{}));
const duration=start=>Math.round(performance.now()-start);
const unique=values=>[...new Set(values.filter(Boolean))];

export function safeUiText(value,max=256){
  if(typeof value!=='string')return null;
  const text=value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  if(!text||/https?:\/\/|[?&](?:token|session|auth|key)=|(?:token|session|authorization|cookie|jsessionid|password)\s*[:=]|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)||/[a-z0-9_-]{64,}/i.test(text))return null;
  return text.slice(0,max);
}
function safePath(value){return typeof value==='string'&&value.length<=2048&&/^[/a-z0-9_ .():#-]+$/i.test(value)?value:null;}
function safeHit(hit){
  return hit&&['x','y','w','h'].every(k=>Number.isFinite(hit[k]))&&hit.w>0&&hit.h>0
    ?{x:hit.x,y:hit.y,w:hit.w,h:hit.h}:null;
}
function safeControl(c){
  const p=safePath(c.path);if(!p)return null;
  return {path:p,name:safeUiText(c.name,80),hit:safeHit(c.hit),
    texts:unique((c.texts||[]).map(t=>safeUiText(t))),
    handlers:unique((c.handlers||[]).filter(h=>typeof h==='string'&&/^[a-z0-9_$.-]{1,120}$/i.test(h)))};
}
function safeNode(n){
  const p=safePath(n.path),text=safeUiText(n.text);return p&&text?{path:p,text,kind:n.kind==='sprite'?'sprite':'label'}:null;
}
function safeNetwork(e){
  const endpoint=safeEndpoint(e.endpoint);if(!endpoint)return null;
  return {endpoint,method:['GET','POST'].includes(e.method)?e.method:null,
    action:typeof e.action==='string'&&/^[a-z][a-z0-9_]{0,63}$/i.test(e.action)?e.action:null,
    status:Number.isInteger(e.status)?e.status:null,request:fields(e.request),response:fields(e.response)};
}
export function observation(result){
  const c=result.capture||{};
  return {state:/^[A-Z_]{1,40}$/.test(c.state||'')?c.state:'UNKNOWN',
    runtimeSupported:Boolean(c.signature),rootMode:c.rootMode==='menu'?'menu':'base',
    screenshot:result.file?path.basename(result.file):null,
    controls:(c.controls||[]).map(safeControl).filter(Boolean),
    labels:(c.probeLabels?.nodes||[]).map(safeNode).filter(Boolean),
    labelInspection:c.probeLabels?'observed':'missing',
    truncation:{controls:Number(c.probeLabels?.controlCount||0)>(c.controls||[]).length,
      labels:!c.probeLabels||c.probeLabels.truncated===true},
    runtimeControlCount:c.probeLabels?.controlCount??null,
    network:(c.network||[]).map(safeNetwork).filter(Boolean)};
}

// Additional READ-ONLY UI evidence; no handlers, game state or provider API is invoked.
// Labels have their own paths, so an OptionN price is not guessed from a sibling.
function inspectLabels(){
  const roots=globalThis.globalRuntime?.sceneRoots||[],safe=fn=>{try{return fn();}catch{return null;}};
  const objectPath=go=>{const p=[];for(let t=go?.transform,n=0;t&&n<24;t=t.parent,n++)p.unshift(String(t.gameObject?.name||''));return p.join('/');};
  const nodes=[],seenLabels=new Set(),seenButtons=new Set();let labelCount=0;
  for(const root of roots){
    for(const type of ['XTButton','CATButton','UIButton']){
      const ctor=globalThis[type];if(!ctor)continue;
      for(const c of safe(()=>root.GetComponentsInChildren(ctor,true))||[]){
        const go=c.gameObject;
        if(go?.activeInHierarchy===true&&c.enabled!==false&&c.xtEnabled!==false&&go.collider&&go.collider.enabled!==false)seenButtons.add(go);
      }
    }
    for(const type of ['UILabel','UISprite']){
      const ctor=globalThis[type];if(!ctor)continue;
      for(const c of safe(()=>root.GetComponentsInChildren(ctor,true))||[]){
        if(c.gameObject?.activeInHierarchy!==true||seenLabels.has(c))continue;
        seenLabels.add(c);const p=objectPath(c.gameObject);
        if(!/Purchase|BuyFeature|BuyBonus|BuyFreeSpins|GameFeatures|AnteBet|IntroScreen|FreeSpins|BetPanel|BetValue/i.test(p))continue;
        const text=type==='UILabel'?c.text:c.spriteName;
        if(typeof text!=='string'||!text.trim())continue;
        labelCount++;if(nodes.length<2000)nodes.push({path:p,text:text.slice(0,256),kind:type==='UILabel'?'label':'sprite'});
      }
    }
  }
  return {nodes,controlCount:seenButtons.size,labelCount,truncated:labelCount>nodes.length};
}
function leaf(c){return `${c.path.split('/').slice(-2).join('/')} ${c.name||''}`;}
function optionScope(c){
  return c.path.match(/^(.*\/(?:Option\d+|Choice\d+|Feature\d+))(?:\/|$)/i)?.[1]||c.path.split('/').slice(0,-2).join('/');
}
function metadata(c,view){
  const scope=optionScope(c),labels=view.labels.filter(n=>n.kind==='label'&&(n.path===scope||n.path.startsWith(scope+'/')));
  const nearbyTexts=unique(c.texts),texts=unique(labels.length?labels.map(n=>n.text):nearbyTexts);
  const costs=values=>values.filter(t=>/[$€£¥]\s*[\d.,]|[\d.,]\s*(?:USD|EUR|GBP|BRL|RUB|MXN|x\b)|\bx\s*\d|\b(?:cost|price)\b/i.test(t));
  return {texts,labels,nearbyTexts,observedCosts:costs(labels.map(n=>n.text)),nearbyCosts:costs(nearbyTexts),
    costAttribution:labels.length?'scoped-labels':'nearby-text-only'};
}
export function positiveConfirmation(view){
  return view.controls.filter(c=>c.hit).filter(c=>{
    const scope=c.path.match(/^(.*\/(?:ConfirmPurchaseWindow|FSPurchaseWindow|BuyBonusWindow|BuyFeatureWindow|PurchaseWindow|GameFeaturesWindow))(?:\/|$)/i)?.[1];
    if(!scope)return false;
    const direct=c.path.slice(scope.length)+' '+(c.name||''),words=[direct,...c.handlers,...c.texts].join(' ');
    const explicitScope=/ConfirmPurchaseWindow|FSPurchaseWindow/i.test(scope);
    return !NEGATIVE.test(direct)&&(explicitScope?POSITIVE:CONFIRM_WORD).test(words)&&
      !c.texts.some(t=>/^\s*(?:cancel|no|close|back)\s*$/i.test(t));
  });
}
function confirmationDialog(view){return view.state==='CONFIRM'||positiveConfirmation(view).length>0||view.controls.some(c=>c.hit&&/\/ConfirmPurchaseWindow(?:\/|$)/i.test(c.path));}
export function candidatesFor(view){
  if(!view.runtimeSupported||confirmationDialog(view)||view.state==='BONUS'||view.state==='INTRO')return [];
  const found=[];
  for(const c of view.controls){
    if(!c.hit||!PURCHASE.test(c.path)||NEGATIVE.test(leaf(c)))continue;
    if(view.state==='BUY_MENU'&&!WINDOW.test(c.path))continue;
    const option=/\/(?:Options|Choices)\/|\/(?:Option|Choice)\d+(?:\/|$)/i.test(c.path);
    const nav=/\/(?:Tabs?|Categories|Pages?)\/|(?:Tab|Category|Page|Expand|More)(?:Button|_Button|Btn)(?:\/|$)/i.test(c.path)||
      c.handlers.some(h=>/(?:open|show|switch).*(?:menu|window|tab|page|confirm)/i.test(h));
    const entry=!WINDOW.test(c.path)&&/MainButton|BuyButton|PurchaseButton|FeatureButton|OpenButton/i.test(c.path);
    const inside=WINDOW.test(c.path)&&/(?:button|collider|option|choice|select)/i.test(leaf(c));
    if(!option&&!nav&&!entry&&!inside)continue;
    const meta=metadata(c,view);
    found.push({...c,...meta,kind:nav||entry?'navigate':'buy',
      reason:nav?'observed-menu-navigation-control':entry?'observed-purchase-menu-entry':'purchase-option-transition-unverified'});
  }
  // Keep every distinct observed target. No four-option cap or minimum count.
  return [...new Map(found.map(c=>[c.path+'|'+JSON.stringify(c.hit),c])).values()];
}
function markFor(c,kind=c.kind){return {x:c.hit.x+c.hit.w/2,y:c.hit.y+c.hit.h/2,kind,
  label:(c.texts.find(t=>/[a-z]/i.test(t))||c.name||c.path.split('/').at(-1)||'Observed control').slice(0,80)};}
function errorCode(error){
  if(typeof error?.code==='string'&&/^[A-Z_]{1,64}$/.test(error.code))return error.code;
  return String(error?.message||'').match(/^([A-Z][A-Z0-9_]{2,63})(?::|$)/)?.[1]||'PROBE_STEP_FAILED';
}
function stateKey(view){return JSON.stringify([view.state,view.controls.filter(c=>PURCHASE.test(c.path)&&c.hit).map(c=>[c.path,c.texts]).sort(),view.labels.filter(n=>n.kind==='label').map(n=>[n.path,n.text]).sort()]);}
export function classifyPurchaseEvent(e){
  if(e.action!=='doSpin'||e.request?.pur==null)return null;
  const r=e.response||{},details={httpStatus:e.status??null,response:fields(r)};
  if(Number.isInteger(e.status)&&(e.status<200||e.status>=300))return {outcome:'rejected',reason:'http-error',...details};
  const codes=[r.status,r.msg_code,r.ext_code].filter(v=>v!=null).map(String);
  if(codes.some(v=>/error|fail|reject|denied|invalid|insufficient/i.test(v)))return {outcome:'rejected',reason:'explicit-application-error',...details};
  // Numeric provider codes have not been established by this probe. Preserve
  // them as unknown instead of inventing success/error meanings from HTTP 200.
  const unexplained=codes.some(v=>v.trim()&&!/^(?:0|ok|success|successful|none)$/i.test(v.trim()));
  if(unexplained)return {outcome:'unknown',reason:'uninterpreted-application-code',...details};
  if(e.status>=200&&e.status<300&&(codes.some(v=>/^(?:ok|success|successful)$/i.test(v.trim()))||Number(r.fs)>0||Number(r.fsmax)>0))
    return {outcome:'accepted',reason:'positive-response-evidence',...details};
  return {outcome:'unknown',reason:'no-positive-response-evidence',...details};
}
function purchaseEvents(events){return events.map(classifyPurchaseEvent).filter(Boolean);}
function writeJson(file,value){fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');}

export async function probeGame(item,{sourceSha,dataDir,executePurchases=false,gameTimeoutMs=240000,maxStates=80}={}){
  const start=performance.now(),url=demoUrl(item.url),slug=gameSlug(url),gameDir=path.join(dataDir,slug);
  fs.mkdirSync(gameDir,{recursive:true});
  const report={sourceSha,game:{url,slug},probe:'observed-purchase-tree',startedAt:new Date().toISOString(),
    executePurchases,entry:null,base:null,states:[],failures:[],blockedCandidates:[],excludedMechanisms:[],
    status:'incomplete',coverage:{status:'incomplete',allPurchasesDiscovered:false},
    fullPurchase:{status:'not-attempted'},fullBonus:{status:'not-attempted'}};
  const save=()=>{report.elapsedMs=duration(start);writeJson(path.join(gameDir,'probe.json'),report);};
  const cfg={...loadConfig(),dataDir:gameDir,saveHar:false};
  const db=new CatalogDB(gameDir,{sqliteCacheMb:cfg.sqliteCacheMb});
  const loader=process.env.CHROMIUM_EXECUTABLE_PATH?{chromiumLoader:async()=>{
    const {chromium}=await import('playwright');
    return {chromium:{launch:options=>chromium.launch({...options,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH})}};
  }}:undefined;
  const browser=new BrowserEngine(cfg,db,loader);
  const originalScreenshot=browser.screenshot.bind(browser),originalFresh=browser.fresh.bind(browser),originalBuyMenu=browser.openKnownBuyMenu.bind(browser);
  // Instrumentation preserves the production prepare/click/retention behavior.
  browser.screenshot=async(session,...args)=>{
    const result=await originalScreenshot(session,...args);
    try{
      const handle=await session.page.locator('iframe[src*="demogamesfree.pragmaticplay.net"]').first().elementHandle();
      const frame=await handle?.contentFrame();
      if(frame)result.capture.probeLabels=await frame.evaluate(inspectLabels);
    }catch{/* A missing supplement is recorded as missing, never fabricated. */}
    return result;
  };
  browser.fresh=async(url,task)=>{
    const session=await originalFresh(url,task);
    if(task.depth===0){report.entry=observation(await browser.screenshot(session,`entry-${task.id}`));save();}
    return session;
  };
  browser.openKnownBuyMenu=async session=>{
    if(db.getTask(session.taskId)?.depth===0){
      report.base=observation(await browser.screenshot(session,`base-${session.taskId}`));
      report.baseMechanisms=report.base.controls.filter(c=>/AnteBet|FeaturePurchase|BuyFeature|GameFeatures|FSPurchase/i.test(c.path));
      report.excludedMechanisms=report.baseMechanisms.filter(c=>c.hit&&/AnteBet/i.test(c.path)).map(c=>({path:c.path,reason:'ante-bet-inventoried-not-traversed'}));
      save();
    }
    return originalBuyMenu(session);
  };
  let gameId=null;
  try{
    db.importUrls([url]);
    const root=db.db.prepare('SELECT t.id,t.status FROM tasks t JOIN games g ON g.id=t.game_id WHERE g.url=? AND t.depth=0').get(url);
    if(root.status!=='queued')throw Object.assign(Error('A fresh per-game data directory is required'),{code:'PROBE_EXISTING_DATA'});
    const queue=[{taskId:root.id,route:[]}],seen=new Set();
    while(queue.length){
      if(duration(start)>gameTimeoutMs||report.states.length>=maxStates){
        report.failures.push({code:duration(start)>gameTimeoutMs?'PROBE_TIME_LIMIT':'PROBE_STATE_LIMIT',pendingTaskIds:queue.map(t=>t.taskId)});break;
      }
      const work=queue.shift(),task=db.getTask(work.taskId),stepStart=performance.now();gameId=task.game_id;
      try{
        if(!db.claim(task.id))throw Object.assign(Error('Task claim failed'),{code:'PROBE_CLAIM_FAILED'});
        const result=await browser.prepare(task);db.ready(task.id,{capture_file:result.file,capture:result.capture});
        const view=observation(result),events=db.eventsForTask(task.id,500).reverse().map(safeNetwork).filter(Boolean);
        const purchases=purchaseEvents(events);
        const state={taskId:task.id,parentTaskId:task.parent_task_id,depth:task.depth,route:work.route,
          elapsedMs:duration(stepStart),...view,taskNetwork:events,live:browser.hasLive(task.id),candidates:[],outcome:'observed'};
        report.states.push(state);
        if(!view.runtimeSupported||!view.controls.length){state.outcome='runtime-unsupported';report.failures.push({taskId:task.id,code:'PROBE_RUNTIME_UNSUPPORTED'});}
        else if(purchases.length){
          state.outcome='purchase-request-observed';state.purchaseResponses=purchases;
          report.fullPurchase.status=purchases.every(p=>p.outcome==='accepted')?'accepted-response-observed':'request-observed-unverified';
          if(purchases.some(p=>p.outcome==='rejected'))report.failures.push({taskId:task.id,code:'PROBE_PURCHASE_REJECTED'});
          if(purchases.some(p=>p.outcome==='unknown'))report.blockedCandidates.push({taskId:task.id,code:'PROBE_PURCHASE_RESPONSE_UNKNOWN'});
        }else if(confirmationDialog(view)){
          const confirms=positiveConfirmation(view);state.confirmationCandidates=confirms;
          state.confirmationDetected=true;
          state.outcome='confirmation-observed';
          if(executePurchases&&confirms.length===1){
            const child=db.commit(task.id,[markFor(confirms[0],'confirm')]).children[0];
            queue.unshift({taskId:child.taskId,route:[...work.route,{path:confirms[0].path,kind:'confirm'}]});
            state.outcome='confirmation-queued';
            // Ownership will transfer to this child; do not release this parent.
            save();continue;
          }
          if(executePurchases&&confirms.length!==1)report.blockedCandidates.push({taskId:task.id,code:'PROBE_CONFIRM_TARGET_AMBIGUOUS',count:confirms.length});
        }else if(view.state==='INTRO'||view.state==='UNKNOWN'){
          state.outcome='unclassified-or-blocked-entry';state.uncertainCandidates=candidatesFor(view);
          report.failures.push({taskId:task.id,code:view.state==='INTRO'?'PROBE_INTRO_NOT_DISMISSED':'PROBE_STATE_UNCLASSIFIED'});
        }else if(view.state==='BONUS'){
          state.outcome='bonus-state-observed';report.blockedCandidates.push({taskId:task.id,code:'PROBE_BONUS_CONTINUATION_UNTESTED'});
        }else{
          const key=stateKey(view);state.candidates=candidatesFor(view);
          const classified=new Set(state.candidates.map(c=>c.path));
          state.unclassifiedPurchaseControls=view.controls.filter(c=>c.hit&&/FeaturePurchase|BuyFeature|PurchaseWindow|FSPurchase|BuyBonus|BuyFreeSpins|AnteBet/i.test(c.path)&&
            (view.state!=='BUY_MENU'||WINDOW.test(c.path))&&!NEGATIVE.test(leaf(c))&&!classified.has(c.path));
          report.blockedCandidates.push(...state.unclassifiedPurchaseControls.map(c=>({taskId:task.id,path:c.path,code:'PROBE_PURCHASE_CONTROL_UNCLASSIFIED'})));
          if(seen.has(key)){state.outcome='previously-observed-menu';}
          else if(state.candidates.length){
            seen.add(key);let actionable=state.candidates;
            if(browser.hasLive(task.id)&&actionable.length>1){
              // Match the server's one-action live-session rule. Replaying an
              // uncertain earlier purchase to clone this menu would be dishonest.
              report.blockedCandidates.push(...actionable.slice(1).map(c=>({taskId:task.id,path:c.path,code:'PROBE_LIVE_MENU_CANNOT_FORK'})));
              actionable=actionable.slice(0,1);
            }
            if(actionable.length>40){
              report.blockedCandidates.push(...actionable.map(c=>({taskId:task.id,path:c.path,code:'PROBE_ENGINE_MARK_LIMIT'})));
              state.outcome='engine-mark-limit';
            }else{
              const children=db.commit(task.id,actionable.map(c=>markFor(c))).children;
              const pending=children.map((child,i)=>({taskId:child.taskId,route:[...work.route,{path:actionable[i].path,kind:actionable[i].kind}]}));
              if(browser.hasLive(task.id)){queue.unshift(...pending);save();continue;}
              queue.push(...pending);state.outcome='menu-candidates-queued';
            }
          }else{
            state.outcome=view.state==='BASE'?'no-observed-purchase-control':'no-classified-purchase-control';
            // Zero buys may be legitimate. Keep evidence without declaring either
            // a missing feature or exhaustive coverage from a negative scan.
          }
        }
        if(browser.hasLive(task.id))await browser.release(task.id);
      }catch(error){
        const code=errorCode(error);report.failures.push({taskId:task.id,code,elapsedMs:duration(stepStart)});
        db.fail(task.id,'failed',code);
        if(browser.hasLive(task.id))await browser.release(task.id).catch(()=>{});
      }
      save();
    }
    const truncated=[report.entry,report.base,...report.states].some(s=>s&&(s.truncation.controls||s.truncation.labels));
    const known=report.states.some(s=>s.candidates.length||s.confirmationDetected);
    report.coverage.status=report.failures.length||report.blockedCandidates.length||report.excludedMechanisms.length||truncated?'partial':known?'observed-candidates-exhausted':'no-observed-purchases';
    report.status=report.coverage.status==='partial'?'incomplete':'observed';
    report.confirmations=report.states.filter(s=>s.confirmationDetected).length;
    report.purchaseRequests=report.states.reduce((n,s)=>n+purchaseEvents(s.taskNetwork).length,0);
    report.purchaseResponses=report.states.flatMap(s=>purchaseEvents(s.taskNetwork));
    if(report.purchaseResponses.length)report.fullPurchase.status=report.purchaseResponses.every(p=>p.outcome==='accepted')?'accepted-response-observed':'request-observed-unverified';
  }catch(error){report.failures.push({code:errorCode(error)});}
  finally{
    try{await browser.stop();}catch{report.failures.push({code:'PROBE_CLEANUP_FAILED'});report.status='incomplete';}
    report.metrics={...browser.metrics,finalOccupancy:browser.liveCount()};
    if(gameId){
      const detail=db.gameDetail(gameId,{taskLimit:10000,eventLimit:20000});
      writeJson(path.join(gameDir,'catalog-sanitized.json'),{
        game:{id:detail.game.id,url,slug,provider:detail.game.provider,gameSymbol:detail.game.game_symbol},
        tasks:detail.tasks.map(t=>({id:t.id,parentTaskId:t.parent_task_id,depth:t.depth,status:t.status,screenshot:t.capture_file?path.basename(t.capture_file):null,error:t.error?errorCode({message:t.error}):null})),
        marks:detail.marks.map(m=>({id:m.id,taskId:m.task_id,ordinal:m.ordinal,x:m.x,y:m.y,kind:m.kind,label:safeUiText(m.label,80)})),
        events:detail.events.flatMap(e=>{const event=safeNetwork(e);return event?[{id:e.id,taskId:e.task_id,...event}]:[];}),
        counts:detail.counts,truncated:detail.truncated});
    }
    db.close();report.finishedAt=new Date().toISOString();save();
  }
  console.log(JSON.stringify({slug,status:report.status,coverage:report.coverage.status,states:report.states.length,
    confirmations:report.confirmations||0,purchaseRequests:report.purchaseRequests||0,failures:report.failures.length,
    blocked:report.blockedCandidates.length,elapsedMs:report.elapsedMs}));
  return report;
}

export async function main(){
  const samplePath=process.argv[2];if(!samplePath)throw Error('Usage: node scripts/probe-purchases.js sample.json');
  const sample=JSON.parse(fs.readFileSync(samplePath,'utf8'));
  if(!Array.isArray(sample.selected)||!sample.selected.length)throw Error('Expected a nonempty selected array');
  const sourceSha=String(process.env.SOURCE_SHA||process.env.GITHUB_SHA||'').toLowerCase();
  if(!/^[a-f0-9]{40}$/.test(sourceSha))throw Error('SOURCE_SHA or GITHUB_SHA must be an exact 40-character revision');
  const dataDir=path.resolve(process.env.DATA_DIR||'data/purchase-probe');fs.mkdirSync(dataDir,{recursive:true});
  const summary={sourceSha,startedAt:new Date().toISOString(),selected:sample.selected.map(x=>({url:demoUrl(x.url),slug:gameSlug(demoUrl(x.url))})),games:[]};
  const save=()=>writeJson(path.join(dataDir,'probe.json'),summary);save();
  for(const item of summary.selected){
    try{
      const r=await probeGame(item,{sourceSha,dataDir,executePurchases:process.env.EXECUTE_PURCHASES==='1',
        gameTimeoutMs:Number(process.env.PROBE_GAME_TIMEOUT_MS)||240000,maxStates:Number(process.env.PROBE_MAX_STATES)||80});
      summary.games.push({slug:item.slug,status:r.status,coverage:r.coverage,states:r.states.length,confirmations:r.confirmations||0,
        purchaseRequests:r.purchaseRequests||0,fullPurchase:r.fullPurchase,fullBonus:r.fullBonus,elapsedMs:r.elapsedMs,failures:r.failures,blocked:r.blockedCandidates.length});
    }catch(error){summary.games.push({slug:item.slug,status:'failed',error:errorCode(error)});}
    save();
  }
  summary.finishedAt=new Date().toISOString();save();
  if(summary.games.some(g=>g.status==='failed'||g.status==='incomplete'))process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
