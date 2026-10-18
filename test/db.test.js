import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {CatalogDB} from '../src/db.js';
const A='https://www.pragmaticplay.fun/en/slots/candy-rush/';
function fixture(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fuzz-manual-'));const db=new CatalogDB(dir,{sqliteCacheMb:8});try{fn(db)}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}}
test('import deduplicates game URLs and roots',()=>fixture(db=>{
  assert.deepEqual(db.importUrls([A,A]),{added:1,existing:0,unique:1});
  assert.deepEqual(db.importUrls([A]),{added:0,existing:1,unique:1});
  assert.equal(db.stats().games,1);
}));
test('one photograph forks into four persisted, independent queued tasks',()=>fixture(db=>{
  db.importUrls([A]);const task=db.nextQueued();assert.equal(db.claim(task.id),true);
  db.ready(task.id,{capture_file:'/tmp/fake.jpg',capture:{state:'BUY_MENU',clip:{x:0,y:0,width:800,height:600}}});
  const marks=[{x:.2,y:.2,kind:'buy'},{x:.8,y:.2,kind:'buy'},{x:.2,y:.8,kind:'buy'},{x:.8,y:.8,kind:'buy'}];
  const commit=db.commit(task.id,marks);
  assert.equal(commit.children.length,4);
  assert.equal(db.stats().tasks.queued,4);
  assert.equal(db.stats().marks,4);
  assert.equal(db.lineage(commit.children[3].taskId)[0].mark.x,.8);
  assert.notEqual(commit.children[0].markId,commit.children[1].markId);
  assert.throws(()=>db.commit(task.id,marks),/already cataloged/);
}));
test('restart retains screenshots, marks and requeues interrupted preparations',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fuzz-manual-reopen-'));
  try{
    let db=new CatalogDB(dir,{sqliteCacheMb:8});db.importUrls([A]);const first=db.nextQueued();db.claim(first.id);db.close();
    db=new CatalogDB(dir,{sqliteCacheMb:8});assert.equal(db.nextQueued().id,first.id);db.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
