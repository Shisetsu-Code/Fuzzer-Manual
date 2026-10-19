import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseArgs,normalizeCatalog,StartLimiter,waitForBase,makeManifest,summary,GithubPublisher} from '../scripts/catalog-batch.js';
const URL='https://www.pragmaticplay.fun/en/slots/candy-rush/';

test('only clean demo URLs and released entries are scheduled; upcoming becomes available on release',()=>{
  const sample={provider:'pragmatic',games:[{url:URL,status:'available'},{url:'https://www.pragmaticplay.fun/en/slots/rat-royale/',status:'upcoming',releaseDate:'2026-10-22'}]};
  assert.deepEqual(normalizeCatalog(sample,new Date('2026-10-18T12:00:00Z')).map(x=>x.status),['available','upcoming']);
  assert.deepEqual(normalizeCatalog(sample,new Date('2026-10-23T12:00:00Z')).map(x=>x.status),['available','available']);
  assert.throws(()=>normalizeCatalog({provider:'pragmatic',games:[URL,URL]}),/Duplicate/);
  assert.throws(()=>normalizeCatalog({provider:'pragmatic',games:['https://casino.example/en/slots/candy-rush/']}),/Unsafe/);
  assert.throws(()=>normalizeCatalog({provider:'pragmatic',games:[URL+'?id=secret']}),/Unsafe/);
});

test('command caps rate to 3 and allows dry-run, resuming and manual capture selections',()=>{
  assert.throws(()=>parseArgs(['--rate=4']),/1..3/);
  assert.throws(()=>parseArgs(['--limit=-1']),/Invalid/);
  assert.throws(()=>parseArgs(['--only=../passwd']),/Invalid/);
  const args=parseArgs(['--rate=2','--limit=3','--headless','--no-publish','--only=candy-rush,rat-royale']);
  assert.equal(args.rate,2);assert.equal(args.limit,3);assert.equal(args.headless,true);assert.equal(args.publish,false);
  assert.deepEqual(args.only,['candy-rush','rat-royale']);
});

test('start reservations persist and respect maximum 3 in any rolling 60 seconds across restarts',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fuzzer-throttle-'));
  try{
    let clock=1_900_000_000_000;
    const sleeper=async ms=>{clock+=ms;};
    const file=path.join(dir,'rate.json');
    const a=new StartLimiter(file,{clock:()=>clock,sleeper});
    const starts=[];
    starts.push(await a.reserve());starts.push(await a.reserve());starts.push(await a.reserve());
    const b=new StartLimiter(file,{clock:()=>clock,sleeper});
    starts.push(await b.reserve());starts.push(await b.reserve());
    assert.equal(starts.length,5);
    for(let i=0;i<starts.length;i++)for(let j=i+3;j<starts.length;j++)assert.ok(starts[j]-starts[i]>=60000);
    for(let i=1;i<starts.length;i++)assert.ok(starts[i]-starts[i-1]>=20000);
  }finally{await fs.rm(dir,{force:true,recursive:true});}
});

test('late introduction prevents early BASE; only intro is clicked and BASE must remain stable',async()=>{
  let time=1000,clicks=0,i=0;
  const stages=['BASE','INTRO','INTRO','BASE','BASE','BASE','BASE','BASE','BASE','BASE','BASE','BASE'];
  const fake={observe:async()=>({state:stages[Math.min(i++,stages.length-1)]}),openKnownIntro:async()=>{clicks++;return {opened:true}}};
  const got=await waitForBase(fake,{}, {timeoutMs:20000,clock:()=>time,sleeper:async ms=>{time+=ms;}});
  assert.equal(got.ready,true);assert.equal(got.view.state,'BASE');assert.equal(clicks,1);
});

test('missing known intro control is reported as review, not falsely READY',async()=>{
  let time=1000;
  const fake={observe:async()=>({state:'INTRO'}),openKnownIntro:async()=>({opened:false})};
  const got=await waitForBase(fake,{}, {timeoutMs:5000,clock:()=>time,sleeper:async ms=>{time+=ms;}});
  assert.equal(got.ready,false);assert.equal(got.reason,'INTRO_NEEDS_MANUAL_CLICK');
});

test('manifest counts distinguish launched games, pending and unreleased',()=>{
  const m=makeManifest({games:new Array(4),capturedAt:'2026-10-19'},'pragmatic-20261019');
  m.entries.a={status:'ready'};m.entries.b={status:'review'};m.entries.c={status:'upcoming'};
  assert.deepEqual(summary(m),{ready:1,review:1,failed:0,upcoming:1,pending:1});
});

test('publishing creates an orphan snapshot branch and stores binaries + manifest independently of source code',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fuzzer-gh-'));
  try{
    await fs.mkdir(path.join(dir,'shots'));await fs.writeFile(path.join(dir,'shots','candy-rush.jpg'),Buffer.from([0xff,0xd8,0xff,0xd9]));
    const publisher=new GithubPublisher({repo:'A/B',branch:'catalog-snapshots',token:'TEST_TOKEN'});
    const calls=[];let head=null,previousTree='';
    publisher.api=async(method,url,body)=>{
      calls.push({method,url,body});
      if(url==='/git/ref/heads/catalog-snapshots'){
        if(!head){const e=Error('missing');e.status=404;throw e;}
        return {object:{sha:head}};
      }
      if(url==='/git/trees')return {sha:body.tree.length?'image-tree':'empty-tree'};
      if(url==='/git/commits'&&method==='POST')return {sha:body.parents.length?'new-commit':'root-commit'};
      if(url==='/git/refs'&&method==='POST'){head=body.sha;return {ok:true};}
      if(url==='/git/commits/root-commit')return {tree:{sha:'empty-tree'}};
      if(url==='/git/blobs')return {sha:'blob-0'};
      if(url==='/git/refs/heads/catalog-snapshots'&&method==='PATCH'){head=body.sha;return {ok:true};}
      throw Error(`Unexpected ${method} ${url}`);
    };
    const manifest=makeManifest({games:[URL]},'pragmatic-test');
    manifest.entries['candy-rush']={slug:'candy-rush',url:URL,status:'ready',image:'shots/candy-rush.jpg',metadata:null};
    const result=await publisher.publish('pragmatic-test',dir,manifest,['shots/candy-rush.jpg']);
    assert.equal(result.sha,'new-commit');
    assert.equal(calls.filter(x=>x.url==='/git/blobs').length,1);
    const tree=calls.find(x=>x.url==='/git/trees'&&x.body.tree.length>0);
    assert.deepEqual(tree.body.tree.map(x=>x.path).sort(),['latest.json','runs/pragmatic-test/manifest.json','runs/pragmatic-test/shots/candy-rush.jpg']);
    const rootTree=calls.find(x=>x.url==='/git/trees'&&!x.body.base_tree);
    assert.equal(rootTree.body.tree.length,1);
    assert.equal(rootTree.body.tree[0].path,'README.md');
    assert.ok(calls.find(x=>x.url==='/git/commits'&&x.body.parents?.length===0));
  }finally{await fs.rm(dir,{force:true,recursive:true});}
});
