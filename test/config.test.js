import test from 'node:test';
import assert from 'node:assert/strict';
import {demoUrl,normalizeMarks,isIrreversible} from '../src/config.js';
test('accept official DEMO catalog URLs and normalize slugs',()=>{
  assert.equal(demoUrl('https://www.pragmaticplay.fun/en/slots/candy-rush'),'https://www.pragmaticplay.fun/en/slots/candy-rush/');
});
test('reject real-money, foreign and URL-injected game URLs',()=>{
  for(const u of ['http://www.pragmaticplay.fun/en/slots/candy-rush/','https://casino.example/casino/slot',
    'https://www.pragmaticplay.fun/en/slots/a/?token=abc','https://www.pragmaticplay.fun@evil.com/en/slots/a/']){
    assert.throws(()=>demoUrl(u));
  }
});
test('validate multiple normalized marks and action kind',()=>{
  assert.deepEqual(normalizeMarks([{x:0.4,y:0.8,kind:'buy'}]),[{x:0.4,y:0.8,kind:'buy',label:''}]);
  assert.throws(()=>normalizeMarks([{x:-1,y:0.2}]));
  assert.throws(()=>normalizeMarks(new Array(41).fill({x:.2,y:.4})));
  assert.equal(isIrreversible('buy'),true);
  assert.equal(isIrreversible('navigate'),false);
});
