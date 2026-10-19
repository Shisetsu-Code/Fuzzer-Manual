/** Sanitized, read-only DEMO transport evidence. No raw HAR or session credentials. */
const FIELDS = new Set([
  'action','pur','bl','ind','c','l','fs','fsmax','rs','rs_c','rs_p','rs_m','rs_t',
  'ch_k','ch_v','na','balance','w','wina','wa','tmb_win','bg_0','bg_1','fsmul',
  'wsl','whms','whvs','whws','status','msg_code','ext_code','rw_c','bgt','pck',
  'fs_total','fswin','sc','tmb','purInit','pur_0','pur_1','pur_2','pur_3'
]);
const SAFE_ACTION=/^[a-z][a-z0-9_]{0,63}$/i;
const HOSTS=['pragmaticplay.net','pragmaticplay.fun'];
export function safeEndpoint(raw){
  try{
    const u=new URL(raw);
    if(u.protocol!=='https:'||!HOSTS.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))return null;
    if(/\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|mp4|mp3|ogg|wasm)(?:$)/i.test(u.pathname))return null;
    return `${u.origin}${u.pathname}`.slice(0,512);
  }catch{return null;}
}
export function extractSymbol(raw){
  try{const u=new URL(raw);if(!safeEndpoint(raw))return null;
    const v=u.searchParams.get('gameSymbol')||u.searchParams.get('symbol');
    return v&&/^[a-zA-Z0-9_-]{2,64}$/.test(v)?v:null;
  }catch{return null;}
}
export function sanitizedFields(raw){
  if(typeof raw!=='string'||raw.length>200000)return {};
  const out={};
  try{
    const str=raw.trim();
    if(str.startsWith('{')){
      const obj=JSON.parse(str);
      if(!obj||typeof obj!=='object'||Array.isArray(obj))return {};
      for(const [k,v] of Object.entries(obj))if(FIELDS.has(k)&&['string','number','boolean'].includes(typeof v))out[k]=String(v).slice(0,512);
    }else{
      const p=new URLSearchParams(str);
      for(const [k,v] of p)if(FIELDS.has(k)&&!(k in out))out[k]=v.slice(0,512);
    }
  }catch{return {};}
  return Object.fromEntries(Object.entries(out).slice(0,64));
}
export function sanitizeRequest(request){
  const endpoint=safeEndpoint(request.url());if(!endpoint)return null;
  const method=request.method().toUpperCase();
  if(!['GET','POST'].includes(method))return null;
  let queryFields={};
  try{queryFields=sanitizedFields(new URL(request.url()).search.slice(1));}catch{}
  const bodyFields=method==='POST'?sanitizedFields(request.postData()||''):{};
  const payload={...queryFields,...bodyFields};
  const action=typeof payload.action==='string'&&SAFE_ACTION.test(payload.action)?payload.action:null;
  // For navigation record only the DEMO loader, not assets/CMP/analytics.
  if(!action&&!/\/openGame\.do$|\/gs2c\/|\/gameService\//i.test(endpoint))return null;
  return {endpoint,method,action,payload};
}
export function sanitizedResponseText(raw){return sanitizedFields(raw);}
