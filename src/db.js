import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {demoUrl,gameSlug,normalizeMarks,isIrreversible} from './config.js';

export class CatalogDB {
  constructor(dir,{sqliteCacheMb=256}={}){
    fs.mkdirSync(dir,{recursive:true});
    this.path=path.join(dir,'catalog.sqlite');
    this.db=new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-${Math.round(sqliteCacheMb*1024)};`);
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS games(
      id INTEGER PRIMARY KEY, url TEXT UNIQUE NOT NULL, slug TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'pragmatic', game_symbol TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES games(id),
      parent_task_id INTEGER REFERENCES tasks(id),
      via_mark_id INTEGER,
      depth INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      capture_file TEXT,
      capture_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(via_mark_id) REFERENCES marks(id)
    );
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,depth DESC,id);
    CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id);
    CREATE TABLE IF NOT EXISTS marks(
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
      ordinal INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
      kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      UNIQUE(task_id,ordinal)
    );
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS network_events(
      id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL REFERENCES games(id),
      task_id INTEGER NOT NULL REFERENCES tasks(id),session_id TEXT NOT NULL,
      provider TEXT NOT NULL, game_symbol TEXT, phase TEXT NOT NULL DEFAULT 'prepare',
      endpoint TEXT NOT NULL, method TEXT NOT NULL, action TEXT,
      status INTEGER, request_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '{}',
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS events_game ON network_events(game_id,id);
    CREATE INDEX IF NOT EXISTS events_task ON network_events(task_id,id);
    CREATE INDEX IF NOT EXISTS events_session ON network_events(session_id,id);
    `);
    // Non-destructive upgrade of catalogs created before provider/trace support.
    const cols=new Set(this.db.prepare('PRAGMA table_info(games)').all().map(c=>c.name));
    if(!cols.has('provider'))this.db.exec("ALTER TABLE games ADD COLUMN provider TEXT NOT NULL DEFAULT 'pragmatic'");
    if(!cols.has('game_symbol'))this.db.exec('ALTER TABLE games ADD COLUMN game_symbol TEXT');
    // A crash cannot leave a permanent "preparing" lock.
    this.db.prepare("UPDATE tasks SET status='queued' WHERE status='preparing'").run();
  }
  close(){this.db.close();}
  setSetting(key,value){this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  getSetting(key,fallback){const r=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value):fallback;}
  importUrls(raw){
    if(!Array.isArray(raw)||raw.length>20000)throw Error('Send an array of up to 20,000 URLs');
    const urls=[...new Set(raw.filter(x=>String(x).trim()).map(demoUrl))];
    const insertGame=this.db.prepare('INSERT OR IGNORE INTO games(url,slug) VALUES(?,?)');
    const idFor=this.db.prepare('SELECT id FROM games WHERE url=?');
    const hasTask=this.db.prepare('SELECT id FROM tasks WHERE game_id=? AND parent_task_id IS NULL');
    const insertTask=this.db.prepare("INSERT INTO tasks(game_id,depth,status) VALUES(?,0,'queued')");
    let added=0,existing=0;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const url of urls){insertGame.run(url,gameSlug(url));const id=idFor.get(url).id;
        if(hasTask.get(id))existing++;else {insertTask.run(id);added++;}
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return {added,existing,unique:urls.length};
  }
  getTask(id){return this.db.prepare(`SELECT t.*,g.url,g.slug,g.provider,g.game_symbol FROM tasks t JOIN games g ON t.game_id=g.id WHERE t.id=?`).get(id)||null;}
  getMark(id){return this.db.prepare('SELECT * FROM marks WHERE id=?').get(id)||null;}
  marksForTask(id){return this.db.prepare('SELECT * FROM marks WHERE task_id=? ORDER BY ordinal').all(id);}
  listReady(limit=100){return this.db.prepare(`SELECT t.id,t.game_id,t.depth,t.status,t.capture_file,t.capture_json,t.updated_at,g.slug,g.url,g.provider,g.game_symbol,COUNT(m.id) as marks_count
  FROM tasks t JOIN games g ON t.game_id=g.id LEFT JOIN marks m ON m.task_id=t.id
  WHERE t.status='ready' GROUP BY t.id ORDER BY t.depth DESC,t.id ASC LIMIT ?`).all(limit).map(x=>({...x,capture:x.capture_json?(({state,rootMode,capturedAt,bytes})=>({state,rootMode,capturedAt,bytes}))(JSON.parse(x.capture_json)):null,capture_json:undefined}));}
  listProblems(limit=100){return this.db.prepare(`SELECT t.id,t.depth,t.status,t.error,g.slug FROM tasks t JOIN games g ON t.game_id=g.id WHERE t.status IN ('failed','blocked') ORDER BY t.id DESC LIMIT ?`).all(limit);}
  stats(){
    const statuses=this.db.prepare('SELECT status,COUNT(*) as count FROM tasks GROUP BY status').all();
    const totals=this.db.prepare('SELECT COUNT(*) as games FROM games').get();
    const marks=this.db.prepare('SELECT COUNT(*) as marks FROM marks').get();
    return {games:totals.games,marks:marks.marks,tasks:Object.fromEntries(statuses.map(r=>[r.status,r.count]))};
  }
  nextQueued(){return this.db.prepare(`SELECT t.*,g.url,g.slug,g.provider,g.game_symbol,m.kind AS via_kind FROM tasks t
    JOIN games g ON g.id=t.game_id LEFT JOIN marks m ON m.id=t.via_mark_id
    WHERE t.status='queued' ORDER BY (t.depth>0) DESC,t.depth DESC,t.id ASC LIMIT 1`).get()||null;}
  queuedBatch(limit=50){return this.db.prepare(`SELECT t.*,g.url,g.slug,m.kind AS via_kind FROM tasks t
    JOIN games g ON g.id=t.game_id LEFT JOIN marks m ON m.id=t.via_mark_id
    WHERE t.status='queued' ORDER BY (t.depth>0) DESC,t.depth DESC,t.id ASC LIMIT ?`).all(limit);}
  queuedRoots(limit=20){return this.db.prepare(`SELECT t.*,g.url,g.slug,g.provider,g.game_symbol,NULL AS via_kind FROM tasks t JOIN games g ON g.id=t.game_id
    WHERE t.status='queued' AND t.depth=0 ORDER BY t.id LIMIT ?`).all(limit);}
  queuedBranches(limit=100){return this.db.prepare(`SELECT t.*,g.url,g.slug,g.provider,g.game_symbol,m.kind AS via_kind FROM tasks t
    JOIN games g ON g.id=t.game_id LEFT JOIN marks m ON m.id=t.via_mark_id
    WHERE t.status='queued' AND t.depth>0 ORDER BY t.depth DESC,t.id ASC LIMIT ?`).all(limit);}
  queueCounts(){return this.db.prepare(`SELECT SUM(CASE WHEN depth=0 THEN 1 ELSE 0 END) AS discovery,
    SUM(CASE WHEN depth>0 THEN 1 ELSE 0 END) AS branches FROM tasks WHERE status='queued'`).get();}
  setGameSymbol(gameId,symbol){
    if(!symbol||!/^[a-zA-Z0-9_-]{2,64}$/.test(symbol))return false;
    return this.db.prepare(`UPDATE games SET game_symbol=? WHERE id=? AND game_symbol IS NULL`).run(symbol,gameId).changes===1;
  }
  recordNetworkEvent(gameId,taskId,sessionId,event){
    if(!Number.isSafeInteger(gameId)||!Number.isSafeInteger(taskId)||!sessionId||!event?.endpoint)return;
    return this.db.prepare(`INSERT INTO network_events(game_id,task_id,session_id,provider,game_symbol,
      phase,endpoint,method,action,status,request_json,response_json,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(gameId,taskId,String(sessionId),event.provider||'pragmatic',
      event.gameSymbol||null,event.phase||'prepare',event.endpoint,event.method||'GET',event.action||null,
      event.status??null,JSON.stringify(event.request||{}),JSON.stringify(event.response||{}),
      event.observedAt||new Date().toISOString());
  }
  eventsForTask(id,limit=100){return this.db.prepare(`SELECT id,game_id,task_id,session_id,provider,
      game_symbol,phase,endpoint,method,action,status,request_json,response_json,observed_at
      FROM network_events WHERE task_id=? ORDER BY id DESC LIMIT ?`).all(id,limit).map(r=>({
      ...r,request:JSON.parse(r.request_json),response:JSON.parse(r.response_json),
      request_json:undefined,response_json:undefined
    }));}
  gameDetail(gameId,{taskLimit=500,eventLimit=2000}={}){
    const game=this.db.prepare('SELECT * FROM games WHERE id=?').get(gameId);
    if(!game)return null;
    const tasks=this.db.prepare('SELECT id,parent_task_id,via_mark_id,depth,status,error,capture_file,created_at FROM tasks WHERE game_id=? ORDER BY id LIMIT ?').all(gameId,taskLimit);
    const marks=this.db.prepare(`SELECT m.* FROM marks m JOIN tasks t ON t.id=m.task_id WHERE t.game_id=? ORDER BY m.id LIMIT ?`).all(gameId,taskLimit*8);
    const events=this.db.prepare(`SELECT id,game_id,task_id,session_id,provider,game_symbol,phase,endpoint,
      method,action,status,request_json,response_json,observed_at
      FROM network_events WHERE game_id=? ORDER BY id LIMIT ?`).all(gameId,eventLimit).map(r=>({
        ...r,request:JSON.parse(r.request_json),response:JSON.parse(r.response_json),request_json:undefined,response_json:undefined
      }));
    const totalTasks=this.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE game_id=?').get(gameId).n;
    const totalEvents=this.db.prepare('SELECT COUNT(*) AS n FROM network_events WHERE game_id=?').get(gameId).n;
    return {game,tasks,marks,events,counts:{tasks:totalTasks,events:totalEvents},truncated:tasks.length<totalTasks||events.length<totalEvents};
  }
  claim(id){return this.db.prepare("UPDATE tasks SET status='preparing',updated_at=datetime('now'),error=NULL WHERE id=? AND status='queued'").run(id).changes===1;}
  ready(id,{capture_file,capture}){
    this.db.prepare("UPDATE tasks SET status='ready',capture_file=?,capture_json=?,error=NULL,updated_at=datetime('now') WHERE id=? AND status='preparing'").run(capture_file,JSON.stringify(capture),id);
  }
  fail(id,status,error){if(!['failed','blocked','queued'].includes(status))throw Error('Invalid failure status');
    this.db.prepare("UPDATE tasks SET status=?,error=?,updated_at=datetime('now') WHERE id=?").run(status,String(error).slice(0,600),id);
  }
  // The photo receives all the marks at once. Every point creates an independent child job.
  commit(id,rawMarks){
    const marks=normalizeMarks(rawMarks),task=this.getTask(id);
    if(!task)throw Error('Task not found');
    if(task.status!=='ready')throw Error('Task already cataloged or not ready');
    if(task.depth>=24&&marks.length)throw Error('Maximum route depth: 24');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const addMark=this.db.prepare('INSERT INTO marks(task_id,ordinal,x,y,kind,label) VALUES(?,?,?,?,?,?)');
      const addTask=this.db.prepare("INSERT INTO tasks(game_id,parent_task_id,via_mark_id,depth,status) VALUES(?,?,?,?,'queued')");
      const children=[];
      marks.forEach((m,i)=>{const mr=addMark.run(id,i+1,m.x,m.y,m.kind,m.label);
        const tr=addTask.run(task.game_id,id,Number(mr.lastInsertRowid),task.depth+1);
        children.push({taskId:Number(tr.lastInsertRowid),markId:Number(mr.lastInsertRowid),kind:m.kind});
      });
      this.db.prepare("UPDATE tasks SET status=?,updated_at=datetime('now') WHERE id=?").run(marks.length?'annotated':'skipped',id);
      this.db.exec('COMMIT');return {children,marks:marks.length};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // Ordered actions from root to the immediate parent of task, including the selected mark.
  lineage(taskId){
    const actions=[];let task=this.getTask(taskId),steps=0;
    if(!task)throw Error('Task not found');
    while(task?.via_mark_id){
      if(++steps>24)throw Error('Route exceeds depth limit');
      const mark=this.getMark(task.via_mark_id),parent=this.getTask(task.parent_task_id);
      if(!mark||!parent)throw Error('Broken route');
      actions.push({mark,parent});task=parent;
    }
    return actions.reverse();
  }
  // Parent tasks beyond an irreversible action require the ORIGINAL live context.
  liveParentRequired(taskId){const a=this.lineage(taskId);return a.some(x=>isIrreversible(x.mark.kind));}
  releaseFailedDescendants(parentId,reason){
    // Leaves the audit trail; does not silently re-run potentially irreversible DEMO operations.
    const descendants=this.db.prepare(`WITH RECURSIVE sub(id) AS (
      SELECT id FROM tasks WHERE parent_task_id=? UNION ALL
      SELECT t.id FROM tasks t JOIN sub ON t.parent_task_id=sub.id
    ) SELECT id FROM sub`).all(parentId);
    for(const {id} of descendants)this.db.prepare("UPDATE tasks SET status='blocked',error=? WHERE id=? AND status IN ('queued','preparing')").run(reason,id);
  }
}
