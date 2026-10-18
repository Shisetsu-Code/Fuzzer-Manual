import test from 'node:test';
import assert from 'node:assert/strict';
import {safeEndpoint,sanitizedFields,extractSymbol,sanitizeRequest} from '../src/trace.js';

test('records only official DEMO endpoints and strips credentials/query',()=>{
  const endpoint='https://gs2c.pragmaticplay.net/gs2c/v3/gameService?token=SECRET&gameSymbol=vs20candy';
  assert.equal(safeEndpoint(endpoint),'https://gs2c.pragmaticplay.net/gs2c/v3/gameService');
  assert.equal(safeEndpoint('https://evil.example/gs2c/gameService'),null);
  assert.equal(safeEndpoint('https://www.pragmaticplay.fun/asset.png'),null);
  assert.equal(extractSymbol('https://demogamesfree.pragmaticplay.net/hub-demo/openGame.do?gameSymbol=vs20candy&token=SECRET'),'vs20candy');
  assert.equal(extractSymbol('https://evil.example/demo?gameSymbol=bad'),null);
});
test('sanitized transport payload never retains tokens or unrelated fields',()=>{
  const payload=sanitizedFields('action=doSpin&pur=2&bl=1&token=SECRET&session=SECRET&balance=100.0&ch_v=0%3A7');
  assert.deepEqual(payload,{action:'doSpin',pur:'2',bl:'1',balance:'100.0',ch_v:'0:7'});
  assert.deepEqual(sanitizedFields('{"action":"doCollect","w":15,"access_token":"SECRET","arr":[1,2]}'),{action:'doCollect',w:'15'});
  const r=sanitizeRequest({url:()=> 'https://gs2c.pragmaticplay.net/gs2c/v3/gameService?auth=X',
    method:()=> 'POST',postData:()=> 'action=doSpin&pur=0&session=SECRET'});
  assert.equal(r.action,'doSpin');assert.equal(r.endpoint.includes('auth'),false);
  assert.deepEqual(r.payload,{action:'doSpin',pur:'0'});
});
test('GET transport preserves allowlisted query fields and omits query secrets',()=>{
  const r=sanitizeRequest({url:()=> 'https://gs2c.pragmaticplay.net/gs2c/v3/gameService?action=doSpin&pur=2&token=SECRET&cookie=COOKIE&other=NOPE',
    method:()=> 'GET',postData:()=> null});
  assert.equal(r.endpoint,'https://gs2c.pragmaticplay.net/gs2c/v3/gameService');
  assert.equal(r.action,'doSpin');
  assert.deepEqual(r.payload,{action:'doSpin',pur:'2'});
  assert.equal(JSON.stringify(r).includes('SECRET'),false);
  assert.equal(JSON.stringify(r).includes('COOKIE'),false);
});
test('allowlisted POST body fields override query fields without retaining secrets',()=>{
  const r=sanitizeRequest({url:()=> 'https://gs2c.pragmaticplay.net/gs2c/v3/gameService?action=doSpin&pur=2&bl=1&token=SECRET',
    method:()=> 'POST',postData:()=> 'action=doCollect&pur=3&session=COOKIE&other=NOPE'});
  assert.equal(r.action,'doCollect');
  assert.deepEqual(r.payload,{action:'doCollect',pur:'3',bl:'1'});
  assert.equal(JSON.stringify(r).includes('SECRET'),false);
  assert.equal(JSON.stringify(r).includes('COOKIE'),false);
});
