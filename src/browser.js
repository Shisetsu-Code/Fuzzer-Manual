import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {inspectPragmatic} from './pragmatic-scan.js';
import {isIrreversible} from './config.js';
import {imageSignature,signatureDiff} from './visual.js';
import {sanitizeRequest,sanitizedResponseText,safeEndpoint,extractSymbol} from './trace.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export class ReplayError extends Error {constructor(code,detail=''){super(`${code}${detail?': '+detail:''}`);this.code=code;}}

export class BrowserEngine {
  constructor(config,db,{chromiumLoader=async()=>({chromium:(await import('playwright')).chromium})}={}){
    this.config=config;this.db=db;this.browser=null;this.launchPromise=null;this.chromiumLoader=chromiumLoader;
    this.live=new Map();this.reserved=new Set();this.busy=new Set();this.pending=new Set();this.stopped=false;this.metrics={sessionsOpened:0,screenshots:0,bytes:0,clicks:0,started:null,lastRenderer:'unknown',failures:0};
  }
  async start(){
    if(this.stopped)throw new ReplayError('ENGINE_STOPPED');
    if(this.browser)return;
    if(this.launchPromise)return this.launchPromise;
    this.launchPromise=this.launchOne();
    try{await this.launchPromise;}finally{this.launchPromise=null;}
  }
  async launchOne(){
    let chromium;
    try{({chromium}=await this.chromiumLoader());}catch{throw Error('Install dependencies first: npm install && npx playwright install chromium');}
    const args=[];
    if(this.config.gpuMode==='d3d11'){
      if(process.platform!=='win32')throw Error('GPU_MODE=d3d11 requires Windows');
      args.push('--use-angle=d3d11','--enable-gpu-rasterization');
    }else if(this.config.gpuMode==='auto'){
      // Chromium chooses ANGLE/D3D11 on compatible Windows hardware; no --disable-gpu.
    }else if(this.config.gpuMode!=='default')throw Error('GPU_MODE must be auto, d3d11, or default');
    const browser=await chromium.launch({headless:this.config.headless,args});
    if(this.stopped){await browser.close();throw new ReplayError('ENGINE_STOPPED');}
    this.browser=browser;
    this.metrics.started=new Date().toISOString();
  }
  async stop(){
    this.stopped=true;
    await this.launchPromise?.catch(()=>{});
    await Promise.allSettled([...this.pending]);
    for(const lease of this.live.values())await this.dispose(lease);
    this.live.clear();this.reserved.clear();
    if(this.browser){await this.browser.close();this.browser=null;}
  }
  hasLive(taskId){return this.live.has(taskId);}
  liveCount(){return this.live.size+this.reserved.size;}
  isBusy(taskId){return this.busy.has(taskId);}
  async release(taskId){
    if(this.isBusy(taskId))throw new ReplayError('ACTIVE_WORK','session is preparing or recapturing');
    const lease=this.live.get(taskId);if(!lease)return false;
    this.busy.add(taskId);
    try{await this.dispose(lease);this.live.delete(taskId);return true;}
    finally{this.busy.delete(taskId);}
  }
  canPrepare(task){
    if(this.stopped||this.isBusy(task.id)||this.isBusy(task.parent_task_id))return false;
    if(this.hasLive(task.parent_task_id))return true;
    const steps=this.db.lineage(task.id);
    if(steps.slice(0,-1).some(x=>isIrreversible(x.mark.kind)))return true; // explicit lost-session outcome
    return !steps.some(x=>isIrreversible(x.mark.kind))||this.liveCount()<this.config.maxLive;
  }
  async fresh(url,task){
    await this.start();
    const ctxOptions={viewport:{width:this.config.viewportWidth,height:this.config.viewportHeight},deviceScaleFactor:1,serviceWorkers:'allow',acceptDownloads:false};
    const context=await this.browser.newContext(ctxOptions);
    let page;
    try{page=await context.newPage();}catch(e){await context.close().catch(()=>{});throw e;}
    if(this.stopped){await context.close().catch(()=>{});throw new ReplayError('ENGINE_STOPPED');}
    this.metrics.sessionsOpened++;
    const session={context,page,id:randomUUID(),events:[],pendingEvents:new Set(),
      created:Date.now(),url,taskId:task.id,gameId:task.game_id,
      gameSymbol:task.game_symbol||null,phase:task.depth===0?'discovery':'branch'};
    const requestSource=new WeakMap();
    page.on('request',request=>{
      const meta=sanitizeRequest(request);
      if(meta)requestSource.set(request,{...meta,taskId:session.taskId,phase:session.phase});
    });
    page.on('response',response=>{
      const request=response.request();
      const meta=requestSource.get(request)||sanitizeRequest(request);
      if(!meta)return;
      const observedAt=new Date().toISOString();
      const work=(async()=>{
        let payload={};
        const len=Number(response.headers()['content-length']||0);
        const type=response.headers()['content-type']||'';
        if((!len||len<=128*1024)&&/json|text|x-www-form-urlencoded/i.test(type)){
          const body=await response.text().catch(()=>null);
          if(body)payload=sanitizedResponseText(body);
        }
        const event={provider:'pragmatic',gameSymbol:session.gameSymbol,
          phase:meta.phase,endpoint:meta.endpoint,method:meta.method,action:meta.action,
          status:response.status(),request:meta.payload,response:payload,observedAt};
        // A response body may resolve after the bounded flush and database shutdown.
        if(session.disposed)return;
        // Persist a sanitized observation, never cookies, query tokens or raw HAR.
        this.db.recordNetworkEvent(session.gameId,meta.taskId,session.id,event);
        session.events.push({endpoint:event.endpoint,method:event.method,action:event.action,
          status:event.status,request:event.request,response:event.response,at:observedAt});
        if(session.events.length>160)session.events.shift();
      })().catch(()=>{});
      session.pendingEvents.add(work);
      work.finally(()=>session.pendingEvents.delete(work));
    });
    try{await this.enter(session);return session;}
    catch(e){await this.dispose(session);throw e;}
  }
  async flushEvents(session,timeoutMs=2500){
    if(!session?.pendingEvents?.size)return;
    await Promise.race([Promise.allSettled([...session.pendingEvents]),
      new Promise(resolve=>setTimeout(resolve,timeoutMs))]);
  }
  async dispose(session){if(session?.context){await this.flushEvents(session);session.disposed=true;await session.context.close().catch(()=>{});}}

  async dismissConsent(session){
    // Late consent overlays are common even after the DEMO iframe exists.
    // Reject only catalogue/CMP consent. Never use DOM click for game controls.
    let rejected=0;
    for(const frame of session.page.frames()){
      const buttons=[
        frame.locator('#onetrust-reject-all-handler'),
        frame.locator('button[data-cookie-action="reject"]'),
        frame.getByRole('button',{name:/^reject all$|^rechazar todo$|^refuser tout$/i})
      ];
      for(const button of buttons){
        try{
          if(!await button.count()||!await button.first().isVisible())continue;
          await button.first().evaluate(el=>el.click());
          rejected++;this.metrics.consentRejects=(this.metrics.consentRejects||0)+1;
          break;
        }catch{/* A stale or cross-origin CMP frame must not block DEMO cataloging. */}
      }
    }
    return rejected;
  }
  async enter(session){
    const page=session.page;
    await page.goto(session.url,{waitUntil:'domcontentloaded',timeout:35000});
    // Only catalog-site controls; never bypass authentication or click inside a real-money account.
    const age=page.locator('button[data-age-gate-confirm="true"]');
    const demo=page.locator('iframe[src*="demogamesfree.pragmaticplay.net"]');
    const buttons=[page.getByRole('button',{name:/play demo|jugar demo|probar demo/i}),page.locator('[data-play-demo-open]')];
    let launchedDemo=false;
    const entryDeadline=Date.now()+13000;
    while(Date.now()<entryDeadline){
      if(await age.count())await age.first().evaluate(el=>el.click()).catch(()=>{});
      await this.dismissConsent(session);
      if(await demo.count())break;
      if(!launchedDemo){
        for(const button of buttons){if(await button.count()){
          launchedDemo=await button.first().click({timeout:1300}).then(()=>true).catch(()=>false);
          if(launchedDemo)break;
        }}
      }
      await sleep(220);
    }
    // If the demo never attached, capture the catalog page for manual review.
    for(let attempt=0;attempt<4;attempt++){
      await this.dismissConsent(session);
      if(attempt<3)await sleep(250);
    }
    // Do not wait a fixed 7 seconds when controls are already ready.
    const start=Date.now();while(Date.now()-start<6000){const view=await this.observe(session);if(view.scan?.supported&&view.scan?.controls.length)break;await sleep(230);}
    // Best-effort only: a visually blocked runtime is still handed to the user for cataloging.
    try{const renderer=await page.evaluate(()=>{
      const c=document.createElement('canvas');const gl=c.getContext('webgl2')||c.getContext('webgl');
      return gl?.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL)||'unreported';
    });this.metrics.lastRenderer=String(renderer).slice(0,160);}catch{}
  }
  async observe(session){
    const page=session.page;
    const iframe=page.locator('iframe[src*="demogamesfree.pragmaticplay.net"]').first();
    let frame=null,bounds=null;
    if(await iframe.count()){
      bounds=await iframe.boundingBox().catch(()=>null);
      const handle=await iframe.elementHandle().catch(()=>null);
      frame=handle?await handle.contentFrame().catch(()=>null):null;
    }
    let scan={supported:false,state:'UNKNOWN',controls:[]};
    if(frame){try{scan=await frame.evaluate(inspectPragmatic);}catch{}}
    const clip=bounds
      ?this.clipForBounds(bounds)
      :{x:0,y:0,width:this.config.viewportWidth,height:this.config.viewportHeight};
    const symbol=frame?extractSymbol(frame.url()):null;
    if(symbol){session.gameSymbol=symbol;this.db.setGameSymbol(session.gameId,symbol);}
    const controls=(scan.controls||[]).map(c=>{
      const sx=bounds&&scan.viewport?.width?bounds.width/scan.viewport.width:1;
      const sy=bounds&&scan.viewport?.height?bounds.height/scan.viewport.height:1;
      const hit=c.hit?{x:(c.hit.x*sx+(bounds?.x||0)-clip.x)/clip.width,
        y:(c.hit.y*sy+(bounds?.y||0)-clip.y)/clip.height,
        w:c.hit.w*sx/clip.width,h:c.hit.h*sy/clip.height}:null;
      return {path:c.path,name:c.name,texts:c.texts,handlers:c.handlers,hit};
    });
    const signature=scan.supported?`${scan.state}|${controls.filter(c=>c.hit).map(c=>c.path).sort().join('|')}`:null;
    return {clip,controls,state:scan.state,signature,frameUrl:frame?.url()?safeEndpoint(frame.url()):null,scan};
  }
  clipForBounds(rect){
    const W=this.config.viewportWidth,H=this.config.viewportHeight;
    const left=Math.max(0,rect.x),top=Math.max(0,rect.y);
    const right=Math.min(W,rect.x+rect.width),bottom=Math.min(H,rect.y+rect.height);
    if(![left,top,right,bottom].every(Number.isFinite)||right<=left||bottom<=top)
      throw new ReplayError('DEMO_OUTSIDE_VIEWPORT');
    const x=Math.floor(left),y=Math.floor(top);
    return {x,y,width:Math.ceil(right)-x,height:Math.ceil(bottom)-y};
  }
  async settle(session,oldState){
    const until=Date.now()+4300;let previous='',matches=0,last=null;
    while(Date.now()<until){last=await this.observe(session);
      if(last.signature&&last.signature===previous)matches++;else matches=0;
      if(matches>=1 && (last.signature!==oldState || Date.now()>until-2500))break;
      previous=last.signature||'';await sleep(230);
    }
    return last||await this.observe(session);
  }
  async openKnownIntro(session){
    await this.dismissConsent(session);
    const view=await this.observe(session);
    if(view.state!=='INTRO')return {opened:false,view};
    const candidates=view.controls.filter(c=>c.hit &&
      /PlayButtonIntro|IntroScreen\/.*(?:Play|Start)Button|IntroScreen\/.*\/CloseButton\/ButtonSpin/i.test(c.path));
    if(candidates.length!==1)return {opened:false,view};
    const h=candidates[0].hit;
    const x=view.clip.x+(h.x+h.w/2)*view.clip.width;
    const y=view.clip.y+(h.y+h.h/2)*view.clip.height;
    if(!this.inClip(view.clip,x,y))return {opened:false,view};
    await session.page.mouse.click(x,y);this.metrics.clicks++;
    const result=await this.settle(session,view.signature);
    return {opened:result.state!=='INTRO',view:result};
  }
  async openKnownBuyMenu(session){
    await this.dismissConsent(session);
    const view=await this.observe(session);
    if(view.state!=='BASE')return {opened:false,view};
    const buys=view.controls.filter(c=>c.hit&&/FeaturePurchase\/MainButton|BuyFeature\/MainButton/i.test(c.path));
    if(buys.length!==1)return {opened:false,view};
    const h=buys[0].hit;
    const x=view.clip.x+(h.x+h.w/2)*view.clip.width;
    const y=view.clip.y+(h.y+h.h/2)*view.clip.height;
    if(!this.inClip(view.clip,x,y))return {opened:false,view};
    await session.page.mouse.click(x,y);this.metrics.clicks++;
    const result=await this.settle(session,view.signature);
    if(result.state==='BUY_MENU')return {opened:true,view:result};
    return {opened:false,view:result};
  }
  inClip(clip,x,y){return x>=clip.x&&y>=clip.y&&x<clip.x+clip.width&&y<clip.y+clip.height;}
  async clickMark(session,parentCapture,mark){
    await this.dismissConsent(session);
    const current=await this.observe(session);
    const expected=parentCapture;
    if(current.scan?.supported && expected?.state && expected.state!=='UNKNOWN' && current.state!==expected.state)
      throw new ReplayError('STATE_MISMATCH',`expected ${expected.state}, got ${current.state}`);
    const intended=expected?.controls?.filter(c=>c.hit&&mark.x>=c.hit.x&&mark.x<=c.hit.x+c.hit.w&&mark.y>=c.hit.y&&mark.y<=c.hit.y+c.hit.h)
      .sort((a,b)=>(a.hit.w*a.hit.h)-(b.hit.w*b.hit.h))[0];
    if(intended && current.scan?.supported){
      const candidates=current.controls.filter(c=>c.path===intended.path&&c.hit);
      if(candidates.length!==1)throw new ReplayError('CONTROL_MISSING',intended.path);
      const h=candidates[0].hit;
      if(h.w<=0||h.h<=0)throw new ReplayError('CONTROL_NOT_VISIBLE');
      // Preserve the operator's fractional position WITHIN the control when layout changed.
      const rx=Math.max(0.02,Math.min(.98,(mark.x-intended.hit.x)/intended.hit.w));
      const ry=Math.max(0.02,Math.min(.98,(mark.y-intended.hit.y)/intended.hit.h));
      mark={...mark,x:h.x+h.w*rx,y:h.y+h.h*ry};
    }else if(!current.scan?.supported && expected?.state!=='UNKNOWN'){
      throw new ReplayError('RUNTIME_UNAVAILABLE');
    }else{
      // A visually cataloged coordinate without a runtime control must match
      // a small visual signature before clicking. GPU/browser animations may
      // make matches less stable; prefer blocking over a wrong irreversible click.
      if(!expected?.visualKey)throw new ReplayError('UNVERIFIED_COORDINATE','no state signature saved');
      const pixels=await session.page.screenshot({type:'jpeg',quality:38,clip:current.clip,timeout:12000});
      const key=await imageSignature(pixels);
      const distance=signatureDiff(key,expected.visualKey);
      if(distance>this.config.visualTolerance)throw new ReplayError('VISUAL_STATE_MISMATCH',`distance ${distance.toFixed(3)} > ${this.config.visualTolerance}`);
    }
    if(!Number.isFinite(mark.x)||!Number.isFinite(mark.y)||mark.x<0||mark.x>1||mark.y<0||mark.y>1)throw new ReplayError('INVALID_MARK');
    const x=current.clip.x+mark.x*current.clip.width,y=current.clip.y+mark.y*current.clip.height;
    if(!this.inClip(current.clip,x,y))throw new ReplayError('CLICK_OUTSIDE_DEMO');
    // Verification is complete. Persist before input: even an input exception may
    // mean the provider received the action. A restart must never replay it.
    if(isIrreversible(mark.kind))this.db.actionDispatched(session.taskId);
    await session.page.mouse.click(x,y);this.metrics.clicks++;
    await this.settle(session,current.signature);
  }
  async screenshot(session,taskId,{rootMode='base'}={}){
    await this.dismissConsent(session);
    const view=await this.observe(session);
    const dir=path.join(this.config.dataDir,'shots');await fs.mkdir(dir,{recursive:true});
    const target=path.join(dir,`task-${taskId}.jpg`),tmp=target+'.tmp';
    const bytes=await session.page.screenshot({type:'jpeg',quality:this.config.jpegQuality,clip:view.clip,timeout:15000});
    await fs.writeFile(tmp,bytes);await fs.rename(tmp,target);
    this.metrics.screenshots++;this.metrics.bytes+=bytes.length;
    const visualKey=await imageSignature(bytes);
    await this.flushEvents(session);
    return {file:target,capture:{sessionId:session.id,provider:'pragmatic',gameSymbol:session.gameSymbol,visualKey,clip:view.clip,width:view.clip.width,height:view.clip.height,
      rootMode,state:view.state,signature:view.signature,controls:view.controls,
      frameUrl:view.frameUrl,network:session.events.slice(-25),capturedAt:new Date().toISOString(),bytes:bytes.length}};
  }
  track(work){
    this.pending.add(work);
    work.then(()=>this.pending.delete(work),()=>this.pending.delete(work));
    return work;
  }
  prepare(task){return this.track(this.prepareTask(task));}
  recapture(task){return this.track(this.captureRetained(task));}
  async captureRetained(task){
    if(this.stopped)throw new ReplayError('ENGINE_STOPPED');
    if(this.isBusy(task.id))throw new ReplayError('ACTIVE_WORK');
    const session=this.live.get(task.id);if(!session)throw new ReplayError('LIVE_SESSION_LOST');
    this.busy.add(task.id);
    try{
      const previous=task.capture_json?JSON.parse(task.capture_json):{};
      return await this.screenshot(session,task.id,{rootMode:session.rootMode||previous.rootMode||'base'});
    }finally{this.busy.delete(task.id);}
  }
  async prepareTask(task){
    if(this.stopped)throw new ReplayError('ENGINE_STOPPED');
    if(this.isBusy(task.id)||this.isBusy(task.parent_task_id))throw new ReplayError('ACTIVE_WORK');
    if(this.hasLive(task.id))throw new ReplayError('ACTIVE_WORK','retained task requires recapture');
    const lineage=this.db.lineage(task.id);
    const requiresLive=lineage.some(x=>isIrreversible(x.mark.kind));
    const sourceParent=this.db.getTask(task.parent_task_id);
    let session=sourceParent?this.live.get(sourceParent.id):null;
    const inherited=Boolean(session);
    if(requiresLive&&lineage.slice(0,-1).some(x=>isIrreversible(x.mark.kind))&&!inherited)
      throw new ReplayError('LIVE_SESSION_LOST','a prior nonreplayable state cannot be reconstructed');
    if(requiresLive&&!inherited&&this.liveCount()>=this.config.maxLive)throw new ReplayError('LIVE_SLOTS_FULL');
    // Capacity and ownership change synchronously, before fresh() or input can yield.
    if(requiresLive&&!inherited)this.reserved.add(task.id);
    this.busy.add(task.id);
    if(inherited){this.busy.add(sourceParent.id);this.live.delete(sourceParent.id);this.live.set(task.id,session);}
    try{
      if(!session)session=await this.fresh(task.url,task);
      if(requiresLive){this.reserved.delete(task.id);this.live.set(task.id,session);}
      session.taskId=task.id;session.gameId=task.game_id;
      session.phase=task.depth===0?'discovery':'branch';
      let mode='base';
      if(!lineage.length){
        await this.openKnownIntro(session);
        const opened=await this.openKnownBuyMenu(session);mode=opened.opened?'menu':'base';
      }else{
        if(!inherited){
          await this.openKnownIntro(session);
          const root=lineage[0].parent;
          const rootInfo=root.capture_json?JSON.parse(root.capture_json):{};
          if(rootInfo.rootMode==='menu'){
            const opened=await this.openKnownBuyMenu(session);
            if(!opened.opened)throw new ReplayError('BUY_MENU_NOT_REOPENED');
          }
          for(const step of lineage.slice(0,-1)){
            const previous=step.parent.capture_json?JSON.parse(step.parent.capture_json):{};
            await this.clickMark(session,previous,step.mark);
          }
        }
        const step=lineage.at(-1);
        const parentInfo=step.parent.capture_json?JSON.parse(step.parent.capture_json):{};
        mode=parentInfo.rootMode;
        session.rootMode=mode||'base';
        await this.clickMark(session,parentInfo,step.mark);
      }
      const result=await this.screenshot(session,task.id,{rootMode:mode});
      return {...result,live:requiresLive};
    }catch(e){this.metrics.failures++;throw e;}
    finally{
      this.reserved.delete(task.id);
      if(!requiresLive&&session)await this.dispose(session);
      this.busy.delete(task.id);if(inherited)this.busy.delete(sourceParent.id);
    }
  }
}
