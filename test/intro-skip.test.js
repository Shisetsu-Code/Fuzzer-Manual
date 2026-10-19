import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserEngine} from '../src/browser.js';

test('legacy CloseButton/ButtonSpin intro is dismissed with a bounded verified click',async()=>{
  const engine=new BrowserEngine({},{});
  const clicks=[];
  const control={path:'GameRoot/UI Root/XTRoot/Root/IntroScreen/content/Landscape/Buttons/CloseButton/ButtonSpin',hit:{x:0.4752,y:0.7963,w:0.0495,h:0.088}};
  engine.dismissConsent=async()=>0;
  engine.observe=async()=>({state:'INTRO',signature:'intro',clip:{x:0,y:0,width:1024,height:576},controls:[control]});
  engine.settle=async()=>({state:'BASE'});
  const out=await engine.openKnownIntro({page:{mouse:{click:async(x,y)=>clicks.push({x,y})}}});
  assert.equal(out.opened,true);
  assert.equal(clicks.length,1);
  assert.ok(clicks[0].x>480&&clicks[0].x<540);
  assert.ok(clicks[0].y>440&&clicks[0].y<510);
});

test('ambiguous intro controls never receive a speculative click',async()=>{
  const engine=new BrowserEngine({},{});
  const hit={x:0.4,y:0.5,w:0.1,h:0.1};let clicked=false;
  engine.dismissConsent=async()=>0;
  engine.observe=async()=>({state:'INTRO',signature:'intro',clip:{x:0,y:0,width:1024,height:576},controls:[
    {path:'IntroScreen/Foo/CloseButton/ButtonSpin',hit},
    {path:'IntroScreen/Bar/CloseButton/ButtonSpin',hit}
  ]});
  const out=await engine.openKnownIntro({page:{mouse:{click:async()=>{clicked=true;}}}});
  assert.equal(out.opened,false);
  assert.equal(clicked,false);
});
