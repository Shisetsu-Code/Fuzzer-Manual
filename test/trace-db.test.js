import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';import fs from 'node:fs';import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CatalogDB} from '../src/db.js';
const A='https://www.pragmaticplay.fun/en/slots/candy-rush/';

test('migrates prior game records without losing cataloged data',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-migration-'));
  try{
    const sqlite=new DatabaseSync(path.join(dir,'catalog.sqlite'));
    sqlite.exec('CREATE TABLE games(id INTEGER PRIMARY KEY,url TEXT UNIQUE NOT NULL,slug TEXT NOT NULL,created_at TEXT);');
    sqlite.prepare('INSERT INTO games(url,slug) VALUES(?,?)').run(A,'candy-rush');sqlite.close();
    const db=new CatalogDB(dir,{sqliteCacheMb:8});
    assert.equal(db.db.prepare('SELECT slug,provider,game_symbol FROM games').get().provider,'pragmatic');
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM games').get().n,1);
    db.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('links payload and endpoint to game / provider / session / task / marks, across restart',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-trace-'));
  try{
    let db=new CatalogDB(dir,{sqliteCacheMb:8});
    db.importUrls([A]);const root=db.nextQueued();db.claim(root.id);
    db.ready(root.id,{capture_file:path.join(dir,'shot.jpg'),capture:{state:'BUY_MENU'}});
    const child=db.commit(root.id,[{x:.25,y:.25,kind:'buy'}]).children[0].taskId;
    assert.equal(db.setGameSymbol(root.game_id,'vs20candy'),true);
    db.recordNetworkEvent(root.game_id,child,'session-uuid',{
      endpoint:'https://gs2c.pragmaticplay.net/gs2c/v3/gameService',
      method:'POST',provider:'pragmatic',gameSymbol:'vs20candy',phase:'branch',action:'doSpin',status:200,
      request:{action:'doSpin',pur:'0'},response:{na:'s',balance:'99800'}
    });
    db.close();
    db=new CatalogDB(dir,{sqliteCacheMb:8});
    const task=db.getTask(child);assert.equal(task.provider,'pragmatic');assert.equal(task.game_symbol,'vs20candy');
    const event=db.eventsForTask(child)[0];
    assert.equal(event.session_id,'session-uuid');assert.equal(event.action,'doSpin');
    assert.deepEqual(event.request,{action:'doSpin',pur:'0'});
    const g=db.gameDetail(root.game_id);assert.equal(g.game.id,root.game_id);
    assert.equal(g.counts.tasks,2);assert.equal(g.counts.events,1);assert.equal(g.marks.length,1);
    db.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
