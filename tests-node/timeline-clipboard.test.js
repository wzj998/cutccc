import test from 'node:test';
import assert from 'node:assert/strict';
import {copyTimelineItems,pasteTimelineItems,encodeClipboard,decodeClipboard} from '../cutccc/web/timeline-clipboard.js';
import {validateEdit,validateVoiceovers,mapSubtitles,outputDuration} from '../cutccc/node/editing.js';
import {captionResizeContext,resizedCaptionTime} from '../cutccc/web/caption-timing.js';
const fixture=()=>({id:'p',sources:[{id:'s',duration:30,has_audio:true},{id:'v',duration:2,has_audio:true}],
 clips:[{source_id:'s',start:10,end:20},{source_id:'s',start:10,end:20}],
 subtitles:{s:[{start:11,end:13,text:'A',style:{fontSize:40,color:'#ffcc55'}},{start:15,end:16,text:'B'}],v:[]},voiceovers:[]});
const mapped=[{sourceId:'s',index:0,occurrence:'clip:0:0',start:1,end:3},{sourceId:'s',index:1,occurrence:'clip:0:1',start:5,end:6}];
const valid=p=>{validateEdit(p.sources,p.clips,p.subtitles);validateVoiceovers(p.sources,p.clips,p.voiceovers);};
test('pasted captions are independent, retain group spacing and render once with reused sources',()=>{
 const p=fixture(),payload=copyTimelineItems(p,'captions',0,mapped),r=pasteTimelineItems(p,payload,7);
 valid(r.project);assert.deepEqual(mapSubtitles(r.project.clips,r.project.subtitles).filter(c=>c.start===7||c.start===11).map(c=>[c.start,c.end,c.text]),[[7,9,'A'],[11,13,'A'],[11,12,'B']]);
 const copies=r.project.subtitles.s.filter(c=>c.timeline_offset!==undefined);
 assert.equal(copies.length,2);assert.equal(mapSubtitles(r.project.clips,r.project.subtitles).length,6);
 copies[0].text='Changed';copies[0].style.color='#ffffff';
 assert.equal(p.subtitles.s[0].text,'A');assert.equal(r.project.subtitles.s.find(c=>c.timeline_offset===undefined).style.color,'#ffcc55');
 assert.equal(r.keys.length,2);
});
test('copying a clipped shifted caption captures only its visible range and can be copied again',()=>{
 const p=fixture();p.subtitles.s=[{start:8,end:12,text:'Clipped',shift:2}];
 const payload=copyTimelineItems(p,'captions',0,[{sourceId:'s',index:0,occurrence:'clip:0:0',start:2,end:4}]);
 assert.deepEqual([payload.items[0].start,payload.items[0].end],[10,12]);
 const r=pasteTimelineItems(p,payload,6);valid(r.project);
 const index=r.project.subtitles.s.findIndex(c=>c.timeline_offset!==undefined);
 const again=copyTimelineItems(r.project,'captions',0,[{sourceId:'s',index,occurrence:`copy:s:${index}`,start:6,end:8}]);
 const twice=pasteTimelineItems(r.project,again,6);valid(twice.project);
 assert.equal(mapSubtitles(twice.project.clips,twice.project.subtitles).filter(c=>c.start===6&&c.end===8).length,2);
});
test('video paste splits at the playhead and moves later independent captions and voiceovers',()=>{
 const p=fixture();p.voiceovers=[{source_id:'v',start:8,volume:.5}];
 p.subtitles.s.push({start:1,end:2,text:'Independent',timeline_offset:8});
 const r=pasteTimelineItems(p,copyTimelineItems(p,'clip',1),5);
 valid(r.project);assert.equal(r.index,1);assert.equal(outputDuration(r.project.clips),30);
 assert.deepEqual(r.project.clips.slice(0,3),[{source_id:'s',start:10,end:15},{source_id:'s',start:10,end:20},{source_id:'s',start:15,end:20}]);
 assert.equal(r.project.voiceovers[0].start,18);
 assert.equal(mapSubtitles(r.project.clips,r.project.subtitles).find(c=>c.text==='Independent').start,19);
 assert.equal(p.clips.length,2);assert.equal(p.voiceovers[0].start,8);
 const end=pasteTimelineItems(p,copyTimelineItems(p,'clip',0),20);assert.equal(end.index,2);valid(end.project);
});
test('paste validation is atomic and keeps ordinary source caption overlap protection',()=>{
 const p=fixture(),before=structuredClone(p),payload=copyTimelineItems(p,'captions',0,mapped);
 assert.throws(()=>pasteTimelineItems(p,payload,19),/空间不足/);
 assert.throws(()=>pasteTimelineItems(p,{...payload,project_id:'other'},1),/所属的工程/);
 assert.throws(()=>pasteTimelineItems(p,{...payload,items:[{...payload.items[0],end:Infinity}]},1));
 assert.deepEqual(p,before);
 p.subtitles.s.push({start:11,end:12,text:'Overlap'});assert.throws(()=>valid(p),/nonoverlapping/);
 p.subtitles.s.at(-1).timeline_offset=4;valid(p);
 p.subtitles.s.at(-1).timeline_offset=NaN;assert.throws(()=>valid(p),/offset/);
 assert.equal(decodeClipboard('ordinary text'),null);assert.deepEqual(decodeClipboard(encodeClipboard(payload)),payload);
});
test('pasted captions can resize without being blocked by the original cue',()=>{
 const r=pasteTimelineItems(fixture(),copyTimelineItems(fixture(),'captions',0,[mapped[0]]),6);
 const index=r.project.subtitles.s.findIndex(c=>c.timeline_offset!==undefined);
 const c=captionResizeContext(r.project,{sourceId:'s',index,occurrence:`copy:s:${index}`,start:6,end:8},'end');
 r.project.subtitles.s[index].end=resizedCaptionTime(c,2);valid(r.project);
 assert.equal(mapSubtitles(r.project.clips,r.project.subtitles).find(c=>c.start===6).end,10);
});
test('voice copy retains volume, and video insertion avoids sub-frame fragments',()=>{
 const p=fixture();p.voiceovers=[{source_id:'v',start:1,volume:0}];
 const r=pasteTimelineItems(p,copyTimelineItems(p,'voice',0),5);valid(r.project);
 assert.deepEqual(r.project.voiceovers[1],{source_id:'v',start:5,volume:0});
 p.clips=[{source_id:'s',start:0,end:2.02}];p.voiceovers=[];p.subtitles={s:[]};
 const split=pasteTimelineItems(p,copyTimelineItems(p,'clip',0),2);valid(split.project);
 assert.equal(split.project.clips.length,2);
});
