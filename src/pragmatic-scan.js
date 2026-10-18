// Runs INSIDE the DEMO frame. Read-only runtime inspection; no synthetic game API calls.
export function inspectPragmatic() {
  const safe=fn=>{try{return fn();}catch{return null;}};
  const canvas=document.querySelector('canvas');
  const roots=globalThis.globalRuntime?.sceneRoots||[];
  if(!canvas || !roots.length)return {supported:false,state:'UNKNOWN',controls:[]};
  const cr=canvas.getBoundingClientRect();
  const rw=globalThis.UHTScreen?.width||canvas.width;
  const rh=globalThis.UHTScreen?.height||canvas.height;
  const drawn=[];const seen=new Set();
  for(const root of roots)for(const type of ['XTButton','CATButton','UIButton']){
    const ctor=globalThis[type];if(!ctor)continue;
    for(const component of safe(()=>root.GetComponentsInChildren(ctor,true))||[]){
      const go=component.gameObject;
      if(!go||seen.has(go)||go.activeInHierarchy!==true||component.enabled===false||component.xtEnabled===false)continue;
      seen.add(go);
      if(!go.collider||go.collider.enabled===false)continue;
      const segments=[];
      for(let t=go.transform,n=0;t&&n<18;n++,t=t.parent)segments.unshift(String(t.gameObject?.name||''));
      const path=segments.join('/');
      const handlers=[safe(()=>component.eventToCode?.name),safe(()=>component.catEventClick?.name),safe(()=>component.catEventPress?.name)].filter(Boolean);
      const texts=[];
      for(let t=go.transform,n=0;t&&n<5;n++,t=t.parent){
        for(const klass of ['UILabel','UISprite']){
          const ctor2=globalThis[klass];if(!ctor2)continue;
          for(const w of safe(()=>t.gameObject.GetComponentsInChildren(ctor2,true))||[]){
            if(w.gameObject?.activeInHierarchy!==true)continue;
            if(typeof w.text==='string'&&w.text.trim())texts.push(w.text.trim().slice(0,64));
            if(typeof w.spriteName==='string'&&w.spriteName)texts.push(w.spriteName.slice(0,64));
          }
        }
        if(texts.length)break;
      }
      const centerAndSize=safe(()=>go.collider.GetTransformedCenterAndSize());
      let hit=null;
      if(centerAndSize?.center && centerAndSize?.size){
        const camera=roots.flatMap(r=>safe(()=>r.GetComponentsInChildren(globalThis.Camera,true))||[])
          .find(c=>c.enabled!==false&&((Number(c.cullingMask)||0)&(1<<go.layer))!==0);
        if(camera){
          const c=centerAndSize.center,s=centerAndSize.size;
          const pts=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y])=>safe(()=>camera.WorldToScreenPoint({x:c.x+x*s.x/2,y:c.y+y*s.y/2,z:c.z})));
          if(pts.every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y))){
            const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
            const toX=x=>cr.x+x*cr.width/rw,toY=y=>cr.y+y*cr.height/rh;
            const x=toX(Math.min(...xs)),y=toY(Math.min(...ys));
            const maxX=toX(Math.max(...xs)),maxY=toY(Math.max(...ys));
            const bx=Math.max(cr.x,x),by=Math.max(cr.y,y),rx=Math.min(cr.right,maxX),ry=Math.min(cr.bottom,maxY);
            if(rx>bx&&ry>by)hit={x:bx,y:by,w:rx-bx,h:ry-by};
          }
        }
      }
      drawn.push({path,name:String(go.name||''),texts:[...new Set(texts)].slice(0,10),handlers,hit});
    }
  }
  const paths=drawn.filter(c=>c.hit).map(c=>c.path);
  let state='UNKNOWN';
  if(paths.some(p=>/ConfirmPurchaseWindow|FSPurchaseWindow\/content\/Buttons/i.test(p)))state='CONFIRM';
  else if(paths.some(p=>/PurchaseWindow\/content\/Options/i.test(p)))state='BUY_MENU';
  else if(paths.some(p=>/IntroScreen/i.test(p)))state='INTRO';
  else if(paths.some(p=>/FreeSpins\/Content|StageResultFreeSpin/i.test(p)))state='BONUS';
  else if(paths.some(p=>/FeaturePurchase|GameFeatures|AnteBet|StartSpin_Button/i.test(p)))state='BASE';
  return {supported:true,state,controls:drawn.slice(0,250)};
}
