import test from 'node:test';
import assert from 'node:assert/strict';
import {signatureDiff} from '../src/visual.js';
test('visual signature distance is bounded and identifies mismatches',()=>{
  const a=Buffer.from([0,127,255]).toString('base64');
  const b=Buffer.from([255,127,0]).toString('base64');
  assert.equal(signatureDiff(a,a),0);
  assert.ok(signatureDiff(a,b)>.6);
  assert.equal(signatureDiff(a,Buffer.from([42]).toString('base64')),1);
});
