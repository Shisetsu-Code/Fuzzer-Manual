import test from 'node:test';
import assert from 'node:assert/strict';

const photo=id=>({id,slug:`photo-${id}`,game_id:id,depth:0,capture:{state:'ready',sessionId:'secret'},url:'https://secret.invalid/?token=secret'});
const mark=(x=.2)=>({x,y:.3,kind:'navigate',label:''});
const memory=()=>({value:null,getItem(){return this.value;},setItem(key,value){this.value=value;}});
async function state(storage){
  let module;
  try{module=await import('../public/annotations.js');}catch{}
  assert.equal(typeof module?.AnnotationState,'function','production per-photo state module exists');
  const state=new module.AnnotationState({storage,catalogId:'test-catalog'});state.mergeQueue([photo(1),photo(2),photo(3)]);return state;
}

test('late failure restores only A, preserves B selection and marks, and retries the original payload',async()=>{
  const s=await state();s.addMark(mark(.123456789));const pending=s.beginSave();
  assert.equal(s.selectedId,2);s.addMark(mark(.7));s.failSave(1,'connection lost');
  assert.equal(s.selectedId,2);assert.deepEqual(s.marks,[mark(.7)]);assert.ok(s.items.some(x=>x.id===1));
  s.select(1);assert.deepEqual(s.marks,[mark(.123457)]);
  assert.equal(s.addMark(mark(.9)),false);const retry=s.beginSave(true);
  assert.deepEqual(retry.marks,pending.marks);assert.equal(s.history.length,0);
});

test('late acknowledgement retires only A and stale queue polls cannot resurrect A',async()=>{
  const s=await state();s.addMark(mark());s.beginSave();s.addMark(mark(.8));
  s.finishSave(1);s.mergeQueue([photo(1),photo(2),photo(3)]);
  assert.equal(s.selectedId,2);assert.deepEqual(s.marks,[mark(.8)]);assert.equal(s.items.some(x=>x.id===1),false);
  assert.deepEqual(s.history[0].savedMarks,[mark()]);s.finishSave(1);assert.equal(s.history.length,1);
});

test('switch, history review, undo, remove, clear and skip target the selected photo',async()=>{
  const s=await state();s.addMark(mark());s.select(2);s.addMark(mark(.8));s.select(1);assert.deepEqual(s.marks,[mark()]);
  s.addMark(mark(.5));s.removeMark(0);s.undo();assert.deepEqual(s.marks,[]);s.addMark(mark());s.beginSave();s.finishSave(1);
  s.previous();assert.equal(s.current.id,1);assert.equal(s.clear(),false);s.leaveReview();assert.equal(s.current.id,2);assert.deepEqual(s.marks,[mark(.8)]);
  s.select(3);s.addMark(mark(.5));s.clear();assert.deepEqual(s.marks,[]);s.select(2);const skipped=s.beginSave(true);assert.deepEqual(skipped.marks,[]);s.failSave(2,'offline');
  assert.deepEqual(s.draft(2),[mark(.8)]);s.select(2);assert.deepEqual(s.beginSave().marks,[]);
});

test('reload retains drafts and uncertain saves for idempotent retry without serializing secrets',async()=>{
  const storage=memory();const s=await state(storage);s.addMark(mark());const original=s.beginSave();s.addMark(mark(.8));
  assert.equal(storage.value.includes('secret'),false);const restored=await state(storage);
  assert.equal(restored.selectedId,2);assert.deepEqual(restored.marks,[mark(.8)]);assert.equal(restored.pending.get(1).status,'failed');
  restored.select(1);assert.deepEqual(restored.beginSave().marks,original.marks);
});

test('invalid or unavailable storage does not prevent editing and retained records are bounded',async()=>{
  for(const storage of [{getItem(){throw Error('denied');},setItem(){throw Error('quota');}},{getItem(){return '{bad';},setItem(){}},{getItem(){return '{"version":1,"drafts":[null,{"item":{"id":5},"marks":[{"x":"bad"}]}]}';},setItem(){}}]){
    const s=await state(storage);assert.equal(s.current.id,1);s.addMark(mark());assert.deepEqual(s.marks,[mark()]);
  }
});

test('pending payload uses server normalization including trimmed bounded labels',async()=>{
  const s=await state();s.addMark({...mark(),label:`  ${'a'.repeat(100)}  `});
  assert.deepEqual(s.beginSave().marks,[{...mark(),label:'a'.repeat(80)}]);
});

test('persistence capacity warns without deleting any live draft or writing an oversized snapshot',async()=>{
  const s=await state();const photos=Array.from({length:501},(_,i)=>photo(i+1));s.mergeQueue(photos);
  for(const item of photos){s.select(item.id);s.addMark(mark());}
  const storage=memory();s.storage=storage;s.persist();
  assert.match(s.persistenceWarning,/recargar/);assert.equal(storage.value,null);assert.equal(s.drafts.size,501);assert.deepEqual(s.draft(1),[mark()]);assert.deepEqual(s.draft(501),[mark()]);
});

test('a queue page omission and out-of-order acknowledgements preserve other photos and history review',async()=>{
  const s=await state();s.addMark(mark());s.beginSave();s.addMark(mark(.5));s.beginSave();s.addMark(mark(.9));
  s.finishSave(2);s.previous();s.finishSave(1);s.mergeQueue([]);
  assert.equal(s.current.id,2);assert.deepEqual(s.marks,[mark(.5)]);s.leaveReview();assert.equal(s.current.id,3);assert.deepEqual(s.marks,[mark(.9)]);
  assert.deepEqual(s.history.map(item=>item.id),[2,1]);assert.equal(s.items.length,1);
});

test('catalog namespaces isolate identical task IDs and restore each catalog when returning',async()=>{
  const {AnnotationState}=await import('../public/annotations.js');const snapshots=new Map();const storage={getItem:key=>snapshots.get(key)||null,setItem:(key,value)=>snapshots.set(key,value)};
  const first=new AnnotationState({storage,catalogId:'first'});first.mergeQueue([photo(1),photo(2)]);first.addMark(mark());first.beginSave();first.finishSave(1);first.addMark(mark(.8));
  const other=new AnnotationState({storage,catalogId:'other'});other.mergeQueue([{...photo(1),slug:'different-game'}]);assert.equal(other.current?.slug,'different-game','old catalog acknowledgement must not hide new task ID');other.addMark(mark(.6));
  const back=new AnnotationState({storage,catalogId:'first'});back.mergeQueue([photo(1),photo(2)]);assert.equal(back.items.some(item=>item.id===1),false);assert.equal(back.current.id,2);assert.deepEqual(back.marks,[mark(.8)]);
  const again=new AnnotationState({storage,catalogId:'other'});again.mergeQueue([{...photo(1),slug:'different-game'}]);assert.deepEqual(again.marks,[mark(.6)]);
  const unknown=new AnnotationState({storage});unknown.mergeQueue([photo(1)]);assert.deepEqual(unknown.marks,[]);assert.match(unknown.persistenceWarning,/catálogo/);
});
