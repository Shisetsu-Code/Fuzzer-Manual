import test from 'node:test';import assert from 'node:assert/strict';
import {BrowserEngine} from '../src/browser.js';
test('parallel workers share ONE Chromium process',async()=>{
  let launches=0,closed=0;
  const chromium={launch:async()=>{launches++;await new Promise(resolve=>setTimeout(resolve,10));return {close:async()=>{closed++}};}};
  const engine=new BrowserEngine({gpuMode:'auto',headless:true},null,{chromiumLoader:async()=>({chromium})});
  await Promise.all([engine.start(),engine.start(),engine.start(),engine.start()]);
  assert.equal(launches,1);
  await engine.stop();assert.equal(closed,1);
});
