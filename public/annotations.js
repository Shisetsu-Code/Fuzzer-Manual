// Per-photo state. Only the explicit metadata allowlist below may reach storage.
const STORAGE_KEY='fuzzer-manual.annotations.v1';
const MAX_RECORDS=500, MAX_BYTES=2_000_000, MAX_RETIRED=5000;
const KINDS=new Set(['navigate','buy','confirm','pick','continue','other']);
function metadata(item){
  if(!item||!Number.isSafeInteger(item.id)||item.id<1||typeof item.slug!=='string')throw Error('Invalid photo');
  return {id:item.id,slug:item.slug.slice(0,200),game_id:item.game_id,depth:item.depth||0,
    provider:item.provider,game_symbol:item.game_symbol,live:Boolean(item.live),capture:{state:typeof item.capture?.state==='string'?item.capture.state.slice(0,80):'CAPTURA',capturedAt:typeof item.capture?.capturedAt==='string'?item.capture.capturedAt.slice(0,64):undefined}};
}
function normalize(marks){
  if(!Array.isArray(marks)||marks.length>40)throw Error('Invalid marks');
  return marks.map(m=>{
    if(!m||!Number.isFinite(m.x)||!Number.isFinite(m.y)||m.x<0||m.x>1||m.y<0||m.y>1||!KINDS.has(m.kind))throw Error('Invalid mark');
    return {x:Math.round(m.x*1e6)/1e6,y:Math.round(m.y*1e6)/1e6,kind:m.kind,label:typeof m.label==='string'?m.label.trim().slice(0,80):''};
  });
}
const copy=marks=>marks.map(m=>({...m}));
export class AnnotationState{
  constructor({storage,catalogId}={}){
    const scoped=typeof catalogId==='string'&&catalogId.length>0&&catalogId.length<=200;
    this.storage=scoped?storage:undefined;this.storageKey=scoped?`${STORAGE_KEY}.${encodeURIComponent(catalogId)}`:null;this.items=[];this.selectedId=null;this.review=null;this.history=[];
    this.drafts=new Map();this.pending=new Map();this.retired=new Set();this.blocked=new Map();this.captureChanges=new Map();this.persistenceWarning=storage&&!scoped?'No se pudo identificar el catálogo; los borradores se conservarán solo en esta pestaña.':scoped&&!storage?'El almacenamiento local no está disponible. Mantené esta pestaña abierta para conservar los borradores.':'';
    this.restore();
  }
  get current(){return this.review||this.items.find(item=>item.id===this.selectedId)||null;}
  get marks(){return this.review?copy(this.review.savedMarks):this.draft(this.selectedId);}
  get locked(){return Boolean(this.review||this.pending.has(this.selectedId)||this.blockReason);}
  get blockReason(){return this.blocked.get(this.selectedId)||'';}
  draft(id){return copy(this.drafts.get(id)?.marks||[]);}
  selectFirst(){
    if(!this.items.some(item=>item.id===this.selectedId))this.selectedId=this.items[0]?.id??null;
  }
  mergeQueue(items,{problems=[],recoveries=[]}={}){
    const available=new Map(items.filter(item=>!this.retired.has(item.id)&&this.pending.get(item.id)?.status!=='saving').map(item=>[item.id,{...item,status:'ready'}]));
    const unavailable=new Map([...problems,...recoveries].map(item=>[item.id,item.error||`Foto no disponible (${item.status||'requiere recaptura'})`]));
    this.blocked.clear();this.captureChanges.clear();const unresolved=[];
    // A retained draft is accessible but cannot become actionable on stale metadata.
    for(const [id,draft] of this.drafts){
      if(this.retired.has(id)||this.pending.get(id)?.status==='saving')continue;
      if(available.has(id)&&!unavailable.has(id)){if(!this.pending.has(id))this.applyReady(id,available.get(id));continue;}
      available.set(id,{...draft.item,live:undefined});
      this.blocked.set(id,unavailable.get(id)||'Verificando el estado actual de la fotografía…');
      if(!unavailable.has(id)&&!this.pending.has(id))unresolved.push(id);
    }
    for(const [id,pending] of this.pending){if(pending.status==='failed'&&!available.has(id))available.set(id,pending.item);}
    this.items=[...available.values()];this.selectFirst();this.persist();return unresolved;
  }
  blockTask(id,reason){if(this.drafts.has(id)&&!this.pending.has(id))this.blocked.set(id,String(reason));}
  reconcileTask(id,{task,marks}={}){
    if(this.pending.has(id)||!this.drafts.has(id))return;
    if(!task||task.id!==id){this.blockTask(id,'No se pudo verificar la fotografía. Actualizá la cola antes de guardarla.');return;}
    let capture=task.capture;
    if(!capture&&typeof task.capture_json==='string'){try{capture=JSON.parse(task.capture_json);}catch{}}
    const item={...metadata({...task,capture}),live:typeof task.live==='boolean'?task.live:undefined};
    this.items=this.items.map(current=>current.id===id?item:current);
    if(task.status==='ready'&&Array.isArray(marks)&&marks.length===0)this.applyReady(id,item);
    else{this.captureChanges.delete(id);this.blocked.set(id,task.error||`Foto no disponible (${task.status||'estado sin confirmar'})`);}
    this.persist();
  }
  applyReady(id,item){
    const draft=this.drafts.get(id),previous=draft.item.capture?.capturedAt,current=item.capture?.capturedAt;
    if(draft.marks.length&&previous!==current&&(previous||current)){
      this.captureChanges.set(id,metadata(item));this.blocked.set(id,'La captura cambió. Conservamos las marcas anteriores para revisión; descartalas explícitamente antes de usar la nueva fotografía.');
    }else{draft.item=metadata(item);this.captureChanges.delete(id);this.blocked.delete(id);}
  }
  acceptCapture(id){
    if(this.review||this.pending.has(id)||!this.captureChanges.has(id))return false;
    const item=this.captureChanges.get(id);this.drafts.set(id,{item,marks:[]});
    this.items=this.items.map(current=>current.id===id?item:current);this.captureChanges.delete(id);this.blocked.delete(id);this.persist();return true;
  }
  confirmRejected(id,detail,attempt){
    if(this.pending.get(id)!==attempt||attempt?.status!=='failed'||detail?.task?.id!==id||detail.task.status!=='ready'||!Array.isArray(detail.marks)||detail.marks.length!==0)return false;
    // The detail must still belong to this exact attempt; a later retry may be uncertain.
    // Only a fresh ready task with no committed marks proves this request did not commit.
    this.pending.delete(id);this.reconcileTask(id,detail);return true;
  }
  validationError(skip=false){
    if(this.review||!this.current)return '';
    if(this.pending.has(this.selectedId))return ''; // Uncertain retries keep their exact request.
    if(this.blockReason)return this.blockReason;
    const count=skip?0:this.marks.length;
    if(this.current.live===true&&count>1)return 'Una sesión LIVE admite una sola acción. Quitá marcas antes de guardar.';
    if(this.current.depth>=24&&count)return 'Profundidad máxima de ruta (24). Quitá las marcas u omití esta fotografía.';
    return '';
  }
  select(id){if(!this.items.some(item=>item.id===id))return false;this.review=null;this.selectedId=id;this.persist();return true;}
  change(marks){
    if(this.locked||!this.current)return false;
    this.drafts.set(this.selectedId,{item:metadata(this.current),marks:normalize(marks)});this.persist();return true;
  }
  addMark(mark){const marks=this.marks;if(marks.length>=40)return false;return this.change([...marks,mark]);}
  removeMark(index){const marks=this.marks;marks.splice(index,1);return this.change(marks);}
  undo(){const marks=this.marks;marks.pop();return this.change(marks);}
  clear(){return this.change([]);}
  previous(){if(!this.history.length)return false;this.review=this.history.at(-1);return true;}
  leaveReview(){this.review=null;}
  beginSave(skip=false){
    if(this.review||!this.current||this.validationError(skip))return null;
    const item=this.current,id=item.id,existing=this.pending.get(id);
    if(existing?.status==='saving')return null;
    // A retry always uses the original request, including an explicit skip.
    const marks=existing?existing.marks:normalize(skip?[]:this.marks);
    const pending={item:metadata(item),marks:copy(marks),status:'saving',error:''};
    this.pending.set(id,pending);
    if(!this.drafts.has(id))this.drafts.set(id,{item:metadata(item),marks:this.marks});
    this.items=this.items.filter(task=>task.id!==id);this.selectFirst();this.persist();
    return {id,marks:copy(marks)};
  }
  failSave(id,error){
    const pending=this.pending.get(id);if(!pending)return;
    pending.status='failed';pending.error=String(error);
    if(!this.items.some(item=>item.id===id))this.items.push(pending.item);
    this.selectFirst();this.persist();
  }
  finishSave(id){
    const pending=this.pending.get(id);if(!pending)return;
    this.history.push({...pending.item,savedMarks:copy(pending.marks)});this.history=this.history.slice(-100);
    this.pending.delete(id);this.drafts.delete(id);this.retired.add(id);
    // Keep the latest acknowledged IDs across reload; active requests are separately hidden.
    if(this.retired.size>MAX_RETIRED)this.retired.delete(this.retired.values().next().value);
    this.items=this.items.filter(item=>item.id!==id);this.selectFirst();this.persist();
  }
  persist(){
    if(!this.storage)return;
    try{
      if(this.drafts.size>MAX_RECORDS||this.pending.size>MAX_RECORDS)throw Error('draft limit');
      const data=JSON.stringify({version:1,selectedId:this.selectedId,drafts:[...this.drafts.values()],
        pending:[...this.pending.values()].map(p=>({item:p.item,marks:p.marks})),retired:[...this.retired],history:this.history});
      if(data.length>MAX_BYTES)throw Error('storage limit');
      this.storage.setItem(this.storageKey,data);this.persistenceWarning='';
    }catch{this.persistenceWarning='No se pudieron conservar los borradores al recargar. Mantené esta pestaña abierta.';}
  }
  restore(){
    if(!this.storage)return;
    try{
      const raw=this.storage.getItem(this.storageKey);if(!raw)return;
      if(raw.length>MAX_BYTES)throw Error('storage limit');
      const data=JSON.parse(raw);if(data.version!==1)return;
      const validRecords=records=>Array.isArray(records)?records.slice(0,MAX_RECORDS):[];
      for(const record of validRecords(data.drafts)){
        try{const item=metadata(record.item);this.drafts.set(item.id,{item,marks:normalize(record.marks)});}catch{}
      }
      for(const record of validRecords(data.pending)){
        try{const item=metadata(record.item);this.pending.set(item.id,{item,marks:normalize(record.marks),status:'failed',error:'Guardado sin confirmar tras recargar. Reintentá para verificarlo.'});}catch{}
      }
      this.retired=new Set(Array.isArray(data.retired)?data.retired.filter(Number.isSafeInteger).slice(-MAX_RETIRED):[]);
      for(const record of (Array.isArray(data.history)?data.history:[]).slice(-100)){
        try{this.history.push({...metadata(record),savedMarks:normalize(record.savedMarks)});}catch{}
      }
      this.selectedId=Number.isSafeInteger(data.selectedId)?data.selectedId:null;
    }catch{this.persistenceWarning='No se pudieron recuperar los borradores locales. El guardado sigue disponible.';}
  }
}
