const $=id=>document.getElementById(id);
const DEFAULT_KEYS={next:'Space',previous:'Shift+Space',undo:'KeyZ',skip:'KeyS',pause:'KeyP',navigate:'Digit1',buy:'Digit2',confirm:'Digit3',pick:'Digit4',continue:'Digit5',other:'Digit6'};
const KEY_LABELS={next:'Guardar y siguiente',previous:'Ver anterior',undo:'Deshacer',skip:'Omitir',pause:'Pausar workers',navigate:'Navegar',buy:'Compra DEMO',confirm:'Confirmación',pick:'Elegir bonus',continue:'Continuar',other:'Otro'};
const store={items:[],selectedId:null,marks:[],mode:'navigate',history:[],review:null,optimistic:new Set(),imageKeep:new Map(),hotkeys:{...DEFAULT_KEYS},running:false,pollBusy:false};
let toastTimer;
function toast(text,isError=false){const node=$('toast');node.textContent=text;node.className=isError?'error':'';node.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.style.display='none',3000);}
async function api(url,method='GET',body){const res=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let data;
  try{data=await res.json();}catch{data={error:`HTTP ${res.status}`};}
  if(!res.ok)throw Error(data.error||`HTTP ${res.status}`);return data;
}
function getCurrent(){return store.review||store.items.find(x=>x.id===store.selectedId)||null;}
function selectFirst(){if(store.selectedId&&!store.items.some(x=>x.id===store.selectedId))store.selectedId=null;
  if(!store.selectedId&&store.items.length)store.selectedId=store.items[0].id;
}
function imageUrl(item){return `/api/images/${item.id}`;}
function preload(items){for(const item of items.slice(0,40)){
  if(store.imageKeep.has(item.id))continue;
  const image=new Image();image.decoding='async';image.src=imageUrl(item);store.imageKeep.set(item.id,image);
  if(store.imageKeep.size>65){const oldest=store.imageKeep.keys().next().value;store.imageKeep.delete(oldest);}
}}
function display(){
  const item=getCurrent();const review=Boolean(store.review);
  $('image-wrap').hidden=!item;$('empty').hidden=!!item;
  $('save-btn').disabled=!item||review;$('skip-btn').disabled=!item||review;
  $('undo-btn').disabled=!store.marks.length||review;
  $('previous-btn').disabled=!store.history.length;
  if(!item){$('game-title').textContent='Sin fotografía seleccionada';$('game-subtitle').textContent='El navegador prepara imágenes mientras catalogás otras';$('photo-status').textContent='COLA VACÍA';$('shot').removeAttribute('src');}
  else{
    $('game-title').textContent=item.slug.replaceAll('-',' ').replace(/\b\w/g,x=>x.toUpperCase());
    $('game-subtitle').textContent=`#${item.id} · Profundidad ${item.depth} · ${item.url}`;
    $('photo-status').textContent=review?'REVISIÓN':`${String(item.capture?.state||'CAPTURA').toUpperCase()} · OLEADA ${item.depth+1}`;
    const url=imageUrl(item);if($('shot').getAttribute('src')!==url)$('shot').src=url;
  }
  $('viewport').classList.toggle('readonly',review);$('hint').textContent=review?'Fotografía anterior (solo lectura) · Espacio para volver':'Clic para marcar · Espacio para guardar y avanzar';
  $('live-note').hidden=!item||!item.live;
  renderPins();renderQueue();
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
    if(!store.review){const b=document.createElement('button');b.textContent='✕';b.title='Quitar esta marca';b.addEventListener('click',()=>{store.marks.splice(i,1);renderPins();});row.append(b);}
    list.append(row);
  });
}
function renderQueue(){
  const list=$('queue-list');list.replaceChildren();$('queue-counter').textContent=`${store.items.length} capturas listas`;
  for(const item of store.items.slice(0,250)){
    const el=document.createElement('div');el.className='queue-item'+(!store.review&&item.id===store.selectedId?' active':'');
    const name=document.createElement('div');name.className='name';name.textContent=item.slug;
    const line=document.createElement('div');line.className='detail';
    const first=document.createElement('span');first.textContent=`#${item.id} · Oleada ${item.depth+1}`;
    const last=document.createElement('span');last.textContent=item.capture?.state||'FOTO';
    line.append(first,last);el.append(name,line);
    el.addEventListener('click',()=>{if(store.marks.length){if(!confirm('¿Descartar marcas todavía no guardadas?'))return;store.marks=[];}store.review=null;store.selectedId=item.id;display();});list.append(el);
  }
}
function renderStatus(status){
  $('stat-games').textContent=status.db.games;
  $('stat-ready').textContent=status.db.tasks.ready||0;
  $('stat-marks').textContent=status.db.marks;
  $('stat-workers').textContent=`${status.active}/${status.workers}`;
  $('stat-live').textContent=`${status.live}/${status.maxLive}`;
  store.running=!status.paused;$('pause-btn').textContent=status.paused?'▶ Iniciar workers':'Ⅱ Pausar workers';
}
async function refresh(){if(store.pollBusy)return;store.pollBusy=true;
  try{
    const [queue,status]=await Promise.all([api('/api/queue?limit=250'),api('/api/status')]);
    store.items=queue.items.filter(t=>!store.optimistic.has(t.id));selectFirst();preload(store.items);
    renderStatus(status);
    const problems=$('problems');problems.replaceChildren();
    if(!queue.problems.length)problems.textContent='Sin incidencias';
    for(const p of queue.problems.slice(0,8)){
      const div=document.createElement('div');div.className='problem';div.textContent=`${p.slug}: ${String(p.error).slice(0,100)}`;problems.append(div);
    }
    if(!store.review)display();
  }catch(e){console.warn(e);}
  finally{store.pollBusy=false;}
}
$('image-wrap').addEventListener('pointermove',e=>{
  const bounds=$('shot').getBoundingClientRect();const x=(e.clientX-bounds.left)/bounds.width,y=(e.clientY-bounds.top)/bounds.height;
  if(x>=0&&x<=1&&y>=0&&y<=1)$('cursor').textContent=`x: ${x.toFixed(4)} / y: ${y.toFixed(4)}`;
});
$('image-wrap').addEventListener('click',e=>{
  if(store.review||!getCurrent())return;
  const r=$('shot').getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1||y<0||y>1)return;
  if(store.marks.length>=40)return toast('Máximo 40 marcas por foto',true);
  store.marks.push({x:Math.round(x*1000000)/1000000,y:Math.round(y*1000000)/1000000,kind:store.mode,label:''});renderPins();
});
function setMode(mode){store.mode=mode;document.querySelectorAll('.modes button').forEach(b=>b.classList.toggle('selected',b.dataset.mode===mode));}
document.querySelectorAll('.modes button').forEach(el=>el.addEventListener('click',()=>setMode(el.dataset.mode)));
function undo(){if(store.review)return;store.marks.pop();renderPins();}
async function commit(skip=false){
  if(store.review){store.review=null;display();return;}
  const item=getCurrent();if(!item)return;
  const marks=skip?[]:[...store.marks];
  store.optimistic.add(item.id);
  store.history.push({...item,savedMarks:marks});if(store.history.length>100)store.history.shift();
  store.items=store.items.filter(t=>t.id!==item.id);store.selectedId=null;store.marks=[];selectFirst();display();
  try{await api(`/api/tasks/${item.id}/commit`,'POST',{marks});store.optimistic.delete(item.id);refresh();}
  catch(e){store.optimistic.delete(item.id);toast(`No se guardó #${item.id}: ${e.message}`,true);refresh();}
}
async function pause(){try{const r=await api('/api/run','POST',{running:!store.running});store.running=!r.paused;refresh();}
  catch(e){toast(e.message,true);}}
function previous(){if(store.history.length){store.review=store.history.at(-1);store.marks=[];display();}}
$('save-btn').addEventListener('click',()=>commit(false));$('skip-btn').addEventListener('click',()=>commit(true));
$('undo-btn').addEventListener('click',undo);$('clear-btn').addEventListener('click',()=>{store.marks=[];renderPins();});
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
  e.preventDefault();
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
async function init(){try{const cfg=await api('/api/settings');if(cfg.hotkeys)store.hotkeys={...DEFAULT_KEYS,...cfg.hotkeys};}catch{}fillKeys();await refresh();setInterval(refresh,1300);}
init();
