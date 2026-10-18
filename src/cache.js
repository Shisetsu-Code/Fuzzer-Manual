import fs from 'node:fs/promises';
// Bounded, byte-counted memory cache. NVMe remains the source of truth.
export class ImageCache {
  constructor(maxBytes=512*1024*1024){this.maxBytes=maxBytes;this.bytes=0;this.entries=new Map();this.inflight=new Map();this.hits=0;this.misses=0;}
  get(path){const v=this.entries.get(path);if(!v){this.misses++;return null;}this.entries.delete(path);this.entries.set(path,v);this.hits++;return v;}
  put(path,buffer){if(buffer.length>this.maxBytes)return;
    const old=this.entries.get(path);if(old){this.bytes-=old.length;this.entries.delete(path);}
    this.entries.set(path,buffer);this.bytes+=buffer.length;
    while(this.bytes>this.maxBytes){const key=this.entries.keys().next().value;this.bytes-=this.entries.get(key).length;this.entries.delete(key);}
  }
  async load(path){const v=this.get(path);if(v)return v;
    if(this.inflight.has(path))return this.inflight.get(path);
    const p=fs.readFile(path).then(bytes=>{this.put(path,bytes);return bytes;}).finally(()=>this.inflight.delete(path));
    this.inflight.set(path,p);return p;
  }
  stats(){return {entries:this.entries.size,bytes:this.bytes,maxBytes:this.maxBytes,hits:this.hits,misses:this.misses};}
  clear(){this.entries.clear();this.bytes=0;}
}
