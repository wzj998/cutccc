import test from 'node:test';
import assert from 'node:assert/strict';
import {gpuRotation,geometryFilter,clipVideoFilter} from '../cutccc/node/export-video-filter.js';
import {wrapExportCues} from '../cutccc/node/subtitle-ass.js';
test('GPU geometry handles quarter-turn metadata and leaves mirrors/arbitrary angles on compatibility path',()=>{
 const video=angle=>({side_data_list:[{side_data_type:'Display Matrix',rotation:angle}]});
 assert.equal(gpuRotation(video(-90)),270);assert.equal(gpuRotation(video(90)),90);
 assert.equal(gpuRotation(video(180)),180);assert.equal(gpuRotation(video(45)),null);
 assert.equal(gpuRotation({side_data_list:[{side_data_type:'Display Matrix',rotation:0,displaymatrix:'00000000: -65536 0 0\n00000001: 0 65536 0\n00000002: 0 0 1073741824'}]}),null);
 assert.match(geometryFilter(1080,1920,270),/scale_cuda=1920:1080.*hwdownload.*transpose=clock.*pad=1080:1920/);
 assert.match(geometryFilter(1080,1920,90),/transpose=cclock/);
 assert.match(geometryFilter(1920,1080,180),/hflip,vflip/);
});
test('both export paths reduce frame rate before spatial transforms and keep exact frame counts',()=>{
 for(const rotation of [null,0,90,180,270]){
  const f=clipVideoFilter({start:1.1,end:3.12},1080,1920,30,61,rotation);
  assert.ok(f.indexOf('fps=30')<f.indexOf('scale'));
  assert.match(f,/trim=end_frame=61/);
 }
});
test('sample wrapping retains original characters, manual line breaks and styles without editing the project',()=>{
 const source=[{start:1,end:3,text:'这是一条比较长的中文字幕，用来验证竖屏导出时自动断行不会裁掉文字。\nPlease keep English words readable.',style:{fontSize:40,marginY:18}}];
 const before=structuredClone(source),wrapped=wrapExportCues(source,432,768);
 assert.deepEqual(source,before);
 assert.ok(wrapped[0].text.split('\n').length>2);
 assert.equal(wrapped[0].text.replaceAll('\n',''),source[0].text.replaceAll('\n',''));
 assert.deepEqual(wrapped[0].style,source[0].style);
 assert.ok(wrapped[0].text.includes('English'));
 const manual=[{start:0,end:1,text:'确实。确认啊，双红色的高\n桩桶并排摆放的啊，确认一\n下，都是刹车点，'}];
 assert.equal(wrapExportCues(manual,430,768)[0].text,manual[0].text);
});
