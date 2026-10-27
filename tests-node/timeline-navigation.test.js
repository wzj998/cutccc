import test from 'node:test';
import assert from 'node:assert/strict';
import {stepFrameTime,followScrollLeft} from '../cutccc/web/timeline-navigation.js';
test('frame navigation advances one edit frame and clamps both boundaries',()=>{
 assert.equal(stepFrameTime(1,1,10),31/30);
 assert.equal(stepFrameTime(1,-1,10),29/30);
 assert.equal(stepFrameTime(1.01,1,10),31/30);
 assert.equal(stepFrameTime(1.01,-1,10),1);
 assert.equal(stepFrameTime(1-1e-6,1,10),31/30);
 assert.equal(stepFrameTime(1+1e-6,-1,10),29/30);
 assert.equal(stepFrameTime(0,-1,10),0);
 assert.equal(stepFrameTime(10,1,10),10);
 let t=0;for(let i=0;i<90;i++)t=stepFrameTime(t,1,10);assert.equal(t,3);
});
test('playhead follow only scrolls outside the viewport, including returning backwards',()=>{
 assert.equal(followScrollLeft(4,100,200,500,2000),200);
 assert.equal(followScrollLeft(8,100,200,500,2000),675);
 assert.equal(followScrollLeft(1,100,800,500,2000),0);
 assert.equal(followScrollLeft(20,100,0,500,2000),1500);
 assert.equal(followScrollLeft(1,100,20,0,2000),20);
});
