/** Dual queue scheduler: discovery never waits for annotation, branches never block the UI. */
export class Scheduler {
  constructor({db,browser,cache,workers=6,discoveryWorkers=2,branchWorkers=4,
    adaptiveWorkers=true,previewCount=50,onProgress=()=>{}}){
    this.db=db;this.browser=browser;this.cache=cache;this.workers=workers;
    this.discoveryWorkers=Math.min(discoveryWorkers,workers);
    this.branchWorkers=Math.min(branchWorkers,Math.max(0,workers-this.discoveryWorkers));
    this.adaptiveWorkers=adaptiveWorkers;this.previewCount=previewCount;
    this.onProgress=onProgress;this.active=new Map();this.errors=[];
    this.paused=db.getSetting('paused',true);this.timer=null;
    this.preloadActive=false;this.closed=false;this.lastCatalogerAt=0;
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>this.pump(),350);this.timer.unref?.();if(!this.paused)this.pump();}
  stop(){this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=null;}
  async drain(timeoutMs=30000){
    const deadline=Date.now()+timeoutMs;
    while(this.active.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    return this.active.size===0;
  }
  setPause(paused){this.paused=!!paused;this.db.setSetting('paused',this.paused);if(!this.paused)this.pump();this.onProgress();}
  noteActivity(active){if(active)this.lastCatalogerAt=Date.now();else this.lastCatalogerAt=0;this.pump();}
  get catalogerActive(){return Date.now()-this.lastCatalogerAt<45000;}
  allocation(){
    let discovery=this.discoveryWorkers;
    if(this.adaptiveWorkers&&this.catalogerActive&&this.workers>1&&discovery>1)discovery--;
    const branches=this.workers-discovery;
    return {discovery,branches,adaptive:this.adaptiveWorkers,catalogerActive:this.catalogerActive};
  }
  pump(){
    if(this.closed||this.paused)return;
    const {discovery,branches}=this.allocation();
    const activeCount=kind=>[...this.active.values()].filter(x=>x===kind).length;
    let lookups=0;
    while(this.active.size<this.workers&&lookups++<this.workers+4){
      const roots=this.db.queuedRoots(100).filter(x=>!this.active.has(x.id)&&this.browser.canPrepare(x));
      const forks=this.db.queuedBranches(200).filter(x=>!this.active.has(x.id)&&this.browser.canPrepare(x));
      let task;
      // Honor each queue's reserved share; lend unused slots to the other queue.
      if(activeCount('discovery')<discovery&&roots.length)task=roots[0];
      else if(activeCount('branch')<branches&&forks.length)task=forks[0];
      else if(forks.length&&this.catalogerActive)task=forks[0];
      else task=roots[0]||forks[0];
      if(!task||!this.db.claim(task.id))break;
      const kind=task.depth===0?'discovery':'branch';
      this.active.set(task.id,kind);
      this.execute(task).finally(()=>{this.active.delete(task.id);if(!this.closed)this.pump();});
    }
  }
  async execute(task){
    try{
      const result=await this.browser.prepare(task);
      this.db.ready(task.id,{capture_file:result.file,capture:result.capture});
      this.cache.load(result.file).catch(()=>{});
      this.warmup();
    }catch(e){
      const code=e.code||e.message||'UNKNOWN';
      const status=['LIVE_SESSION_LOST','STATE_MISMATCH','CONTROL_MISSING','UNVERIFIED_COORDINATE',
        'VISUAL_STATE_MISMATCH','BUY_MENU_NOT_REOPENED','RUNTIME_UNAVAILABLE',
        'CLICK_OUTSIDE_DEMO','LIVE_SLOTS_FULL'].includes(code)?'blocked':'failed';
      this.db.fail(task.id,status,String(e.message||e));
      this.errors.push({taskId:task.id,reason:String(e.message||e).slice(0,180)});
      if(this.errors.length>20)this.errors.shift();
    }finally{this.onProgress();}
  }
  async warmup(){
    if(this.preloadActive||this.closed)return;
    this.preloadActive=true;
    try{
      for(const task of this.db.listReady(this.previewCount)){
        if(this.closed)break;
        if(task.capture_file)await this.cache.load(task.capture_file).catch(()=>{});
      }
    }finally{this.preloadActive=false;}
  }
  status(){
    const counts=this.db.queueCounts();
    return {paused:this.paused,active:this.active.size,workers:this.workers,
      allocation:{...this.allocation(),activeDiscovery:[...this.active.values()].filter(x=>x==='discovery').length,
        activeBranches:[...this.active.values()].filter(x=>x==='branch').length,queuedDiscovery:counts.discovery||0,
        queuedBranches:counts.branches||0},
      live:this.browser.liveCount(),maxLive:this.browser.config.maxLive,
      db:this.db.stats(),cache:this.cache.stats(),browser:this.browser.metrics,errors:this.errors.slice(-5)};
  }
}
