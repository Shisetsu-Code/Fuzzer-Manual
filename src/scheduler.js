export class Scheduler {
  constructor({db,browser,cache,workers=3,previewCount=50,onProgress=()=>{}}){
    this.db=db;this.browser=browser;this.cache=cache;this.workers=workers;
    this.previewCount=previewCount;this.onProgress=onProgress;
    this.active=new Set();this.errors=[];this.paused=db.getSetting('paused',true);this.timer=null;
    this.preloadActive=false;this.closed=false;
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>this.pump(),350);this.timer.unref?.();if(!this.paused)this.pump();}
  stop(){this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=null;}
  setPause(paused){this.paused=!!paused;this.db.setSetting('paused',this.paused);if(!this.paused)this.pump();this.onProgress();}
  pump(){
    if(this.closed||this.paused)return;
    while(this.active.size<this.workers){
      const candidates=this.db.queuedBatch(250);
      // A full LIVE lease budget must not starve thousands of independent root games.
      const task=candidates.find(x=>!this.active.has(x.id)&&this.browser.canPrepare(x))
        ||this.db.queuedRoots(20).find(x=>!this.active.has(x.id)&&this.browser.canPrepare(x));
      if(!task||!this.db.claim(task.id))break;
      this.active.add(task.id);
      this.execute(task).finally(()=>{this.active.delete(task.id);this.pump();});
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
      const status=['LIVE_SESSION_LOST','STATE_MISMATCH','CONTROL_MISSING','UNVERIFIED_COORDINATE','VISUAL_STATE_MISMATCH','BUY_MENU_NOT_REOPENED','RUNTIME_UNAVAILABLE','CLICK_OUTSIDE_DEMO'].includes(code)?'blocked':'failed';
      this.db.fail(task.id,status,String(e.message||e));
      this.errors.push({taskId:task.id,reason:String(e.message||e).slice(0,180)});
      if(this.errors.length>20)this.errors.shift();
    }finally{this.onProgress();}
  }
  async warmup(){
    if(this.preloadActive||this.closed)return;
    this.preloadActive=true;
    try{
      const list=this.db.listReady(this.previewCount);
      // Prefetch conservatively: async disk I/O and bounded LRU, never all images in RAM.
      for(const task of list){if(this.closed)break;if(task.capture_file)await this.cache.load(task.capture_file).catch(()=>{});}
    }finally{this.preloadActive=false;}
  }
  status(){return {paused:this.paused,active:this.active.size,workers:this.workers,live:this.browser.liveCount(),maxLive:this.browser.config.maxLive,
    db:this.db.stats(),cache:this.cache.stats(),browser:this.browser.metrics,errors:this.errors.slice(-5)};}
}
