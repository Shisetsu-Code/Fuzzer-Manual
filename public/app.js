import {AnnotationState} from './annotations.js';
const $=id=>document.getElementById(id);
const DEFAULT_KEYS={next:'Space',previous:'Shift+Space',undo:'KeyZ',skip:'KeyS',pause:'KeyP',navigate:'Digit1',buy:'Digit2',confirm:'Digit3',pick:'Digit4',continue:'Digit5',other:'Digit6'};
const KEY_LABELS={next:'Guardar y siguiente',previous:'Ver anterior',undo:'Deshacer',skip:'Omitir',pause:'Pausar workers',navigate:'Navegar',buy:'Compra DEMO',confirm:'Confirmación',pick:'Elegir bonus',continue:'Continuar',other:'Otro'};
let localDrafts;try{localDrafts=window.localStorage;}catch{}
const sessionUI={catalogId:null,imageScope:`tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,mode:'navigate',imageKeep:new Map(),hotkeys:{...DEFAULT_KEYS},running:false,pollBusy:false,lastActivityAt:Date.now(),traceFor:null,recoveries:[],recoveryBusy:new Set(),recoveryErrors:new Map()};
let store=Object.assign(new AnnotationState(),sessionUI);
let toastTimer;
function toast(text,isError=false){const node=$('toast');node.textContent=text;node.className=isError?'error':'';node.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.style.display='none',3000);}
async function api(url,method='GET',body){const res=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let data;
  try{data=await res.json();}catch{const error=Error(`Respuesta HTTP ${res.status} sin confirmación legible`);if(!res.ok)error.httpStatus=res.status;throw error;}
  if(!res.ok){const error=Error(data.error||`HTTP ${res.status}`);error.httpStatus=res.status;throw error;}return data;
}
function getCurrent(){return store.current;}
function imageUrl(item){return `/api/images/${item.id}?catalog=${encodeURIComponent(store.catalogId||store.imageScope)}&capture=${encodeURIComponent(item.capture?.capturedAt||'unversioned')}`;}
function preload(items){for(const item of items.slice(0,40)){
  const url=imageUrl(item);if(store.imageKeep.has(url))continue;
  const image=new Image();image.decoding='async';image.src=url;store.imageKeep.set(url,image);
  if(store.imageKeep.size>65){const oldest=store.imageKeep.keys().next().value;store.imageKeep.delete(oldest);}
}}
function display(){
  const item=getCurrent();const review=Boolean(store.review);
  $('image-wrap').hidden=!item;$('empty').hidden=!!item;
  const pending=store.pending.get(item?.id);
  $('save-btn').disabled=Boolean(!item||pending?.status==='saving'||(!review&&!pending&&store.blockReason));$('skip-btn').disabled=!item||store.locked;
  $('save-btn').textContent=review?'Volver a la cola':pending?'Reintentar guardado y siguiente →':'Guardar marcas y siguiente →';
  $('undo-btn').disabled=!store.marks.length||store.locked;
  $('clear-btn').disabled=!item||!store.marks.length||store.locked;
  $('previous-btn').disabled=!store.history.length;
  $('new-capture-btn').hidden=review||!store.captureChanges.has(item?.id);
  if(!item){$('game-title').textContent='Sin fotografía seleccionada';$('game-subtitle').textContent='El navegador prepara imágenes mientras catalogás otras';$('photo-status').textContent='COLA VACÍA';$('shot').removeAttribute('src');}
  else{
    $('game-title').textContent=item.slug.replaceAll('-',' ').replace(/\b\w/g,x=>x.toUpperCase());
    $('game-subtitle').textContent=`Foto #${item.id} · Juego #${item.game_id} · ${item.provider||'pragmatic'} · ${item.game_symbol||item.slug} · Oleada ${item.depth+1}`;
    $('photo-status').textContent=review?'REVISIÓN':pending?'GUARDADO SIN CONFIRMAR':store.blockReason?'NO DISPONIBLE':`${String(item.capture?.state||'CAPTURA').toUpperCase()} · OLEADA ${item.depth+1}`;
    const url=imageUrl(item);if($('shot').getAttribute('src')!==url)$('shot').src=url;
    if(store.traceFor!==item.id){store.traceFor=item.id;loadTrace(item);}
  }
  if(!item){store.traceFor=null;$('game-trace-info').textContent='Seleccioná una fotografía.';
    $('trace-list').textContent='Sin operaciones registradas.';$('export-game').hidden=true;}
  $('viewport').classList.toggle('readonly',store.locked);$('hint').textContent=review?'Fotografía anterior (solo lectura) · Atajo siguiente para volver':pending?'Reintentá el envío original para confirmar el guardado':store.blockReason||'Clic para marcar · Guardar para avanzar';
  $('draft-warning').hidden=!store.persistenceWarning;$('draft-warning').textContent=store.persistenceWarning;
  $('live-note').hidden=!item||!item.live;
  renderPins();renderQueue();renderPending();
}
function renderPins(){
  const pins=$('pins');pins.replaceChildren();const marks=store.review?.savedMarks||store.marks;
  marks.forEach((m,i)=>{const el=document.createElement('div');el.className='pin';el.style.left=`${m.x*100}%`;el.style.top=`${m.y*100}%`;el.textContent=String(i+1);el.title=`${m.kind} (${m.x.toFixed(4)}, ${m.y.toFixed(4)})`;pins.append(el);});
  $('marks-count').textContent=`${marks.length} ${marks.length===1?'marca':'marcas'}`;
  const list=$('mark-list');list.replaceChildren();
  if(!marks.length){const n=document.createElement('div');n.className='muted small';n.textContent='Todavía no hay marcas.';list.append(n);return;}
  marks.forEach((m,i)=>{const row=document.createElement('div');row.className='mark-row';
    const a=document.createElement('div');const badge=document.createElement('span');badge.className='ordinal';badge.textContent=String(i+1);a.append(badge,document.createTextNode(m.kind));
    const small=document.createElement('small');small.textContent=`x=${m.x.toFixed(4)} · y=${m.y.toFixed(4)}`;a.append(small);row.append(a);
    if(!store.locked){const b=document.createElement('button');b.textContent='✕';b.title='Quitar esta marca';b.addEventListener('click',()=>{store.removeMark(i);display();});row.append(b);}
    list.append(row);
  });
}
function renderQueue(){
  const list=$('queue-list');list.replaceChildren();$('queue-counter').textContent=`${store.items.length} capturas listas`;
  for(const item of store.items){
    const el=document.createElement('div');el.className='queue-item'+(!store.review&&item.id===store.selectedId?' active':'');
    const name=document.createElement('div');name.className='name';name.textContent=item.slug;
    const line=document.createElement('div');line.className='detail';
    const first=document.createElement('span');first.textContent=`Juego #${item.game_id} · Foto #${item.id} · Oleada ${item.depth+1}`;
    const last=document.createElement('span');last.textContent=store.pending.has(item.id)?'REINTENTAR':store.blocked.has(item.id)?'NO DISPONIBLE':store.draft(item.id).length?'BORRADOR':item.capture?.state||'FOTO';
    line.append(first,last);el.append(name,line);
    el.addEventListener('click',()=>{store.select(item.id);display();});list.append(el);
  }
}
function renderStatus(status){
  $('stat-games').textContent=status.db.games;
  $('stat-ready').textContent=status.db.tasks.ready||0;
  $('stat-marks').textContent=status.db.marks;
  $('stat-workers').textContent=`${status.active}/${status.workers}`;
  const a=status.allocation||{};
  $('worker-allocation').textContent=`D ${a.activeDiscovery||0}/${a.discovery??'—'} · R ${a.activeBranches||0}/${a.branches??'—'}`;
  $('stat-live').textContent=`${status.live}/${status.maxLive}`;
  store.running=!status.paused;$('pause-btn').textContent=status.paused?'▶ Iniciar workers':'Ⅱ Pausar workers';
}
async function loadTrace(item){
  $('game-trace-info').textContent=`Proveedor: ${item.provider||'pragmatic'} · Juego #${item.game_id} · Symbol: ${item.game_symbol||item.capture?.gameSymbol||'pendiente'} · Sesión: ${item.capture?.sessionId||'—'}`;
  const link=$('export-game');link.hidden=false;link.href=`/api/games/${item.game_id}/export`;
  link.download=`${item.provider||'pragmatic'}-${item.game_symbol||item.slug}-${item.game_id}.json`;
  $('trace-list').textContent='Consultando operaciones…';
  try{
    const data=await api(`/api/tasks/${item.id}/trace?limit=25`);
    if(store.traceFor!==item.id)return;
    const list=$('trace-list');list.replaceChildren();
    if(!data.events.length){list.textContent='Sin operaciones de red del proveedor para esta captura.';return;}
    for(const e of data.events){
      const entry=document.createElement('div');entry.className='trace-entry';
      const heading=document.createElement('div');
      heading.textContent=`${e.action||e.method} · HTTP ${e.status??'—'} · ${e.endpoint}`;
      const detail=document.createElement('small');
      detail.textContent=`Sesión ${e.session_id.slice(0,8)} · Petición: ${JSON.stringify(e.request)} · Respuesta: ${JSON.stringify(e.response)}`;
      entry.append(heading,detail);list.append(entry);
    }
  }catch(e){if(store.traceFor===item.id)$('trace-list').textContent=`No se pudo leer tráfico: ${e.message}`;}
}
async function refresh(){if(store.pollBusy)return;store.pollBusy=true;
  try{
    const [queue,status]=await Promise.all([api('/api/queue?limit=250'),api('/api/status')]);
    const unresolved=store.mergeQueue(queue.items,{problems:queue.problems,recoveries:queue.recoveries});preload(store.items);
    store.recoveries=queue.recoveries||[];renderRecoveries();
    renderStatus(status);
    const problems=$('problems');problems.replaceChildren();
    if(!queue.problems.length)problems.textContent='Sin incidencias';
    for(const p of queue.problems.slice(0,8)){
      const div=document.createElement('div');div.className='problem';div.textContent=`${p.slug}: ${String(p.error).slice(0,100)}`;problems.append(div);
    }
    display();
    await Promise.all(unresolved.map(async id=>{
      try{store.reconcileTask(id,await api(`/api/tasks/${id}`));}
      catch(e){store.blockTask(id,`No se pudo verificar la fotografía: ${e.message}`);}
    }));
    if(unresolved.length)display();
  }catch(e){console.warn(e);}
  finally{store.pollBusy=false;}
}
$('image-wrap').addEventListener('pointermove',e=>{
  const bounds=$('shot').getBoundingClientRect();const x=(e.clientX-bounds.left)/bounds.width,y=(e.clientY-bounds.top)/bounds.height;
  if(x>=0&&x<=1&&y>=0&&y<=1)$('cursor').textContent=`x: ${x.toFixed(4)} / y: ${y.toFixed(4)}`;
});
$('image-wrap').addEventListener('click',e=>{
  if(store.locked||!getCurrent())return;
  const r=$('shot').getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1||y<0||y>1)return;
  if(store.marks.length>=40)return toast('Máximo 40 marcas por foto',true);
  store.lastActivityAt=Date.now();
  store.addMark({x,y,kind:store.mode,label:''});display();
});
function setMode(mode){store.mode=mode;document.querySelectorAll('.modes button').forEach(b=>b.classList.toggle('selected',b.dataset.mode===mode));}
document.querySelectorAll('.modes button').forEach(el=>el.addEventListener('click',()=>setMode(el.dataset.mode)));
function undo(){store.undo();display();}
async function commit(skip=false){store.lastActivityAt=Date.now();
  if(store.review){store.leaveReview();display();return;}
  const invalid=store.validationError(skip);if(invalid){toast(invalid,true);return;}
  const request=store.beginSave(skip);if(!request)return;
  display();
  try{await api(`/api/tasks/${request.id}/commit`,'POST',{marks:request.marks});store.finishSave(request.id);display();refresh();}
  catch(e){
    store.failSave(request.id,e.message);toast(`No se guardó #${request.id}: ${e.message}`,true);display();
    const rejectedAttempt=store.pending.get(request.id);
    if(e.httpStatus){try{store.confirmRejected(request.id,await api(`/api/tasks/${request.id}`),rejectedAttempt);}catch{}}
    display();refresh();
  }
}
function renderPending(){
  const list=$('pending-saves');list.replaceChildren();
  $('pending-section').hidden=!store.pending.size;
  for(const [id,pending] of store.pending){
    const row=document.createElement('div');row.className='pending-save';
    const text=document.createElement('div');text.textContent=pending.status==='saving'?`Foto #${id}: guardando…`:`Foto #${id}: ${pending.error}`;row.append(text);
    if(pending.status==='failed'){
      const button=document.createElement('button');button.textContent=`Ver y reintentar #${id}`;
      button.addEventListener('click',()=>{store.select(id);display();});row.append(button);
    }
    list.append(row);
  }
}
function renderRecoveries(){
  const list=$('recoveries');list.replaceChildren();
  $('recovery-section').hidden=!store.recoveries.length;
  for(const recovery of store.recoveries){
    const row=document.createElement('div');row.className='recovery';
    const name=document.createElement('b');name.textContent=`${recovery.slug} · Foto #${recovery.id}`;
    const error=document.createElement('div');error.className='recovery-error';error.textContent=store.recoveryErrors.get(recovery.id)||recovery.error||'Sesión viva retenida';
    row.append(name,error);
    for(const [action,label] of [['recapture','Recapturar'],['release','Liberar']]){
      const button=document.createElement('button');button.textContent=label;button.disabled=store.recoveryBusy.has(recovery.id);
      button.addEventListener('click',()=>{recoverSession(recovery.id,action);});row.append(button);
    }
    list.append(row);
  }
}
async function recoverSession(id,action){
  if(store.recoveryBusy.has(id))return;
  store.recoveryBusy.add(id);store.recoveryErrors.delete(id);renderRecoveries();
  try{
    await api(`/api/tasks/${id}/${action}`,'POST',{});
    store.recoveries=store.recoveries.filter(item=>item.id!==id);
    toast(action==='recapture'?`Foto #${id} recapturada`:`Sesión #${id} liberada`);
    await refresh();
  }catch(e){store.recoveryErrors.set(id,e.message);toast(e.message,true);}
  finally{store.recoveryBusy.delete(id);renderRecoveries();}
}
async function pause(){try{const r=await api('/api/run','POST',{running:!store.running});store.running=!r.paused;refresh();}
  catch(e){toast(e.message,true);}}
function previous(){store.previous();display();}
$('save-btn').addEventListener('click',()=>commit(false));$('skip-btn').addEventListener('click',()=>commit(true));
$('undo-btn').addEventListener('click',undo);$('clear-btn').addEventListener('click',()=>{store.clear();display();});
$('new-capture-btn').addEventListener('click',()=>{store.acceptCapture(store.selectedId);display();});
$('previous-btn').addEventListener('click',previous);$('pause-btn').addEventListener('click',pause);
$('refresh-btn').addEventListener('click',refresh);
$('import-open').addEventListener('click',()=>$('import-dialog').showModal());
$('settings-open').addEventListener('click',()=>$('settings-dialog').showModal());
$('import-submit').addEventListener('click',async()=>{
  const urls=$('import-text').value.trim().split(/[\r\n]+/).filter(Boolean);if(!urls.length)return;
  try{const result=await api('/api/import','POST',{urls});toast(`${result.added} juegos agregados · ${result.existing} existentes`);$('import-dialog').close();$('import-text').value='';refresh();}
  catch(e){toast(e.message,true);}
});
function shortcutName(e){const modifiers=[e.ctrlKey?'Ctrl':null,e.altKey?'Alt':null,e.shiftKey?'Shift':null].filter(Boolean);
  return [...modifiers,e.code].join('+');
}
document.addEventListener('keydown',e=>{
  if(e.target.closest('dialog')||['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)||e.altKey||e.metaKey||e.ctrlKey)return;
  const code=shortcutName(e),keys=store.hotkeys;
  const action=Object.keys(keys).find(key=>keys[key]===code);
  if(!action)return;
  if(e.repeat&&(action==='next'||action==='skip')){e.preventDefault();return;}
  store.lastActivityAt=Date.now();e.preventDefault();
  if(action==='next')commit(false);else if(action==='previous')previous();else if(action==='undo')undo();else if(action==='skip')commit(true);else if(action==='pause')pause();else setMode(action);
});
function fillKeys(){const fields=$('key-fields');fields.replaceChildren();
  for(const [action,label] of Object.entries(KEY_LABELS)){
    const l=document.createElement('label');l.textContent=label;const input=document.createElement('input');input.dataset.action=action;input.value=store.hotkeys[action]||'';
    input.addEventListener('keydown',e=>{e.preventDefault();input.value=shortcutName(e);});fields.append(l,input);
  }
}
$('settings-dialog').addEventListener('show',fillKeys);
$('settings-open').addEventListener('click',fillKeys);
$('reset-keys').addEventListener('click',()=>{store.hotkeys={...DEFAULT_KEYS};fillKeys();});
$('save-keys').addEventListener('click',async()=>{
  const keys={};for(const input of document.querySelectorAll('#key-fields input'))keys[input.dataset.action]=input.value;
  const unique=Object.values(keys);
  if(unique.some(x=>!x)||new Set(unique).size!==unique.length)return toast('Los atajos no pueden estar vacíos ni repetidos',true);
  try{await api('/api/settings','POST',{hotkeys:keys});store.hotkeys=keys;$('settings-dialog').close();toast('Atajos guardados');}catch(e){toast(e.message,true);}
});
async function heartbeat(){
  const active=document.visibilityState==='visible'&&Date.now()-store.lastActivityAt<90000;
  await api('/api/activity','POST',{active}).catch(()=>{});
}
window.addEventListener('focus',()=>{store.lastActivityAt=Date.now();heartbeat();});
document.addEventListener('visibilitychange',heartbeat);
async function init(){try{const cfg=await api('/api/settings');
  store=Object.assign(new AnnotationState({storage:localDrafts,catalogId:cfg.catalogId}),sessionUI);
  store.catalogId=typeof cfg.catalogId==='string'?cfg.catalogId:null;
  if(!cfg.catalogId)store.persistenceWarning='No se pudo identificar el catálogo; los borradores se conservarán solo en esta pestaña.';
  if(cfg.hotkeys)store.hotkeys={...DEFAULT_KEYS,...cfg.hotkeys};
  }catch{store.persistenceWarning='No se pudo consultar el catálogo; los borradores se conservarán solo en esta pestaña.';}fillKeys();await refresh();await heartbeat();setInterval(refresh,1300);setInterval(heartbeat,8000);}
init();
