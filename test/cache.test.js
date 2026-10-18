import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageCache} from '../src/cache.js';
test('LRU bounds in-memory data and updates recency',()=>{
  const c=new ImageCache(8);
  c.put('a',Buffer.alloc(4));c.put('b',Buffer.alloc(4));assert.equal(c.get('a')?.length,4);
  c.put('c',Buffer.alloc(4));assert.equal(c.get('b'),null);assert.ok(c.stats().bytes<=8);
});
