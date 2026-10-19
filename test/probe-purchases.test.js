import test from 'node:test';
import assert from 'node:assert/strict';
import {candidatesFor,classifyPurchaseEvent,observation,positiveConfirmation,safeUiText} from '../scripts/probe-purchases.js';

const option=n=>({path:`/FeaturePurchase/PurchaseWindow/content/Options/Option${n}/content/ColliderHolder/Collider`,name:'Collider',
  hit:{x:.1*n,y:.2,w:.08,h:.2},texts:[],handlers:[]});
const view=(controls,extra={})=>({state:'BUY_MENU',runtimeSupported:true,controls,labels:[],...extra});

test('purchase discovery keeps every observed option beyond four and does not require three',()=>{
  assert.equal(candidatesFor(view(Array.from({length:7},(_,i)=>option(i+1)))).length,7);
  assert.equal(candidatesFor(view([option(1)])).length,1);
  assert.deepEqual(candidatesFor(view([])),[]);
});

test('costs are associated with the observed option label subtree despite ambiguous nearby text',()=>{
  const result=candidatesFor(view([{...option(1),texts:['$100.00','$500.00']},option(2)],{labels:[
    {path:'/FeaturePurchase/PurchaseWindow/content/Options/Option1/content/Price',kind:'label',text:'$100.00'},
    {path:'/FeaturePurchase/PurchaseWindow/content/Options/Option2/content/Price',kind:'label',text:'$500.00'},
  ]}));
  assert.deepEqual(result[0].observedCosts,['$100.00']);
  assert.deepEqual(result[1].observedCosts,['$500.00']);
  assert.deepEqual(result[0].nearbyCosts,['$100.00','$500.00']);
  assert.equal(result[0].kind,'buy','unknown option transitions retain their original session');
});

test('an unsupported runtime yields no automatically actionable candidates',()=>{
  assert.deepEqual(candidatesFor(view([option(1)],{runtimeSupported:false,state:'UNKNOWN'})),[]);
  assert.deepEqual(candidatesFor(view([option(1)],{state:'CONFIRM'})),[]);
});

test('a confirmation must identify an affirmative control, with ambiguity left visible',()=>{
  const control=name=>({...option(1),path:`/FeaturePurchase/ConfirmPurchaseWindow/content/Buttons/${name}`,name});
  assert.deepEqual(positiveConfirmation(view([control('CancelButton')],{state:'CONFIRM'})),[]);
  assert.equal(positiveConfirmation(view([control('ConfirmButton'),control('CancelButton')],{state:'CONFIRM'})).length,1);
  assert.equal(positiveConfirmation(view([control('ConfirmButton'),control('BuyButton')],{state:'CONFIRM'})).length,2);
});

test('a purchase-dialog confirmation is guarded even when the runtime classifier says UNKNOWN or BASE',()=>{
  const confirm={...option(1),path:'/FeaturePurchase/BuyBonusWindow/content/Buttons/ConfirmButton',name:'ConfirmButton'};
  const cancel={...confirm,path:'/FeaturePurchase/BuyBonusWindow/content/Buttons/CancelButton',name:'CancelButton'};
  for(const state of ['UNKNOWN','BASE']){
    const v=view([confirm,cancel],{state});
    assert.equal(positiveConfirmation(v).length,1);
    assert.deepEqual(candidatesFor(v),[],'a confirmation cannot fall through to default-phase option execution');
  }
  assert.deepEqual(positiveConfirmation(view([{...confirm,path:'/UnrelatedWindow/ConfirmButton'}],{state:'UNKNOWN'})),[]);
});

test('purchase request observation distinguishes rejection and unknown HTTP 200 from positive response evidence',()=>{
  const event={action:'doSpin',status:200,request:{pur:'2'},response:{}};
  assert.equal(classifyPurchaseEvent(event).outcome,'unknown');
  assert.equal(classifyPurchaseEvent({...event,response:{status:'ERROR',msg_code:'insufficient_balance'}}).outcome,'rejected');
  assert.equal(classifyPurchaseEvent({...event,response:{msg_code:'17',fs:'10'}}).outcome,'unknown','unestablished numeric codes are not invented');
  assert.equal(classifyPurchaseEvent({...event,response:{fs:'10'}}).outcome,'accepted');
  assert.equal(classifyPurchaseEvent({...event,status:403}).outcome,'rejected');
  assert.equal(classifyPurchaseEvent({...event,action:'doInit'}),null);
});

test('missing supplementary label inspection is an explicit incomplete observation',()=>{
  const v=observation({capture:{state:'BASE',signature:'BASE|x',controls:[option(1)]}});
  assert.equal(v.labelInspection,'missing');
  assert.equal(v.truncation.labels,true);
});

test('rich observations retain public labels but remove URL credentials and report scanner truncation',()=>{
  const r=observation({file:'/tmp/private/task-1.jpg',capture:{state:'BUY_MENU',signature:'BUY_MENU|x',
    sessionId:'SECRET',frameUrl:'https://example.test/?token=SECRET',
    controls:[{...option(1),texts:['Buy Free Spins','$100.00','token=SECRET','https://demo.test/?token=SECRET']}],
    probeLabels:{controlCount:300,truncated:false,nodes:[]},
    network:[{endpoint:'https://demogamesfree.pragmaticplay.net/gs2c/v3/gameService?token=SECRET',method:'POST',action:'doSpin',status:200,request:{pur:'6',token:'SECRET'},response:{fs:'10',session:'SECRET'}}]}});
  assert.deepEqual(r.controls[0].texts,['Buy Free Spins','$100.00']);
  assert.equal(r.truncation.controls,true);
  assert.deepEqual(r.network[0].request,{pur:'6'});
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.equal(safeUiText('demo.person@example.com'),null);
});
