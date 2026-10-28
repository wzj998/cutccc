import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {getTracks,addTrack,removeTrack,trackItems,videoPlacements,videoAtTime,moveVideoToTrack,insertSourceOnTrack,videoDuration} from '../cutccc/web/tracks.js';
import {validateEdit,validateVoiceovers,mapSubtitles,clipFrames,outputDuration} from '../cutccc/node/editing.js';
import {projectDuration} from '../cutccc/web/audio-tracks.js';
import {render} from '../cutccc/node/media.js';
import {capture} from '../cutccc/node/processes.js';
const fixture=()=>({id:'p',sources:[{id:'a',duration:10,has_audio:true},{id:'b',duration:10,has_audio:true}],clips:[{source_id:'a',start:1,end:3},{source_id:'b',start:2,end:4}],subtitles:{a:[{start:1.5,end:2,text:'A'}],b:[{start:2.5,end:3,text:'B'}]},voiceovers:[]});
test('track clocks retain the original frame rounding for half-frame source boundaries',()=>{
  for(const end of [.15,.25,.35,.45]){const clip={start:0,end};assert.equal(outputDuration([clip]),clipFrames(clip)/30);}
});
test('track creation preserves legacy placements; moving video assigns an independent position and priority',()=>{
  const original=fixture(),{project:p,track}=addTrack(original,'video','upper');
  assert.equal(original.tracks,undefined);assert.equal(p.tracks[0].id,'upper');
  assert.deepEqual(videoPlacements(p).map(p=>p.start),[0,2]);
  const moved=moveVideoToTrack(p,1,track.id,1);
  assert.deepEqual(videoPlacements(moved).map(p=>p.start),[0,1]);assert.equal(videoDuration(moved),3);
  assert.equal(videoAtTime(moved,.5).index,0);assert.equal(videoAtTime(moved,1.5).index,1);
  assert.deepEqual(mapSubtitles(moved.clips,moved.subtitles,[],moved.sources,moved.tracks).map(c=>[c.start,c.text]),[[.5,'A'],[1.5,'B']]);
  validateEdit(moved.sources,moved.clips,moved.subtitles,moved.tracks);
});
test('tracks delete only their own items and validate type, ID and count constraints',()=>{
  let {project:p}=addTrack(fixture(),'video','upper');p=moveVideoToTrack(p,1,'upper',5);
  assert.equal(trackItems(p,'upper'),1);const removed=removeTrack(p,'upper');assert.equal(removed.clips.length,1);assert.equal(p.clips.length,2);
  validateEdit(removed.sources,removed.clips,removed.subtitles,removed.tracks);
  assert.equal(videoAtTime(p,3),null);
  assert.throws(()=>moveVideoToTrack(p,0,'subtitle-main',2),/视频/);
  assert.throws(()=>validateEdit(p.sources,p.clips,p.subtitles,[...p.tracks,p.tracks[0]]),/track/);
  assert.throws(()=>validateEdit(p.sources,[{...p.clips[0],track_id:'missing'}],p.subtitles,p.tracks),/track/);
});
test('library sources can be inserted on video or audio tracks, including audio tails',()=>{
  const {project:p,track}=addTrack(fixture(),'audio','sound');
  const inserted=insertSourceOnTrack(p,'b',track.id,3);assert.equal(inserted.kind,'voice');assert.equal(inserted.project.voiceovers[0].track_id,'sound');assert.equal(projectDuration(inserted.project),13);
  validateVoiceovers(inserted.project.sources,inserted.project.clips,inserted.project.voiceovers,inserted.project.tracks);
  assert.throws(()=>insertSourceOnTrack(p,'b','subtitle-main',0),/字幕/);
  const pasted=insertSourceOnTrack(p,'b','video-main',1);assert.equal(pasted.project.clips.at(-1).timeline_start,1);assert.equal(pasted.project.clips.at(-1).track_id,'video-main');
});
const hasFFmpeg=spawnSync('ffmpeg',['-version'],{windowsHide:true}).status===0;
test('real multi-track export preserves gaps, upper-layer priority and the lower layer after the overlay ends',{skip:!hasFFmpeg},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cutccc-tracks-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const paths={};for(const [id,color] of [['a','red'],['b','blue']]){paths[id]=path.join(root,id+'.mkv');await capture('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i',`color=c=${color}:s=48x80:r=30:d=4`,'-c:v','ffv1',paths[id]]);}
  const p={id:'p',sources:[{id:'a',duration:4,width:48,height:80,has_audio:false},{id:'b',duration:4,width:48,height:80,has_audio:false}],
    tracks:[{id:'upper',type:'video',name:'Upper'},{id:'lower',type:'video',name:'Lower'}],
    clips:[{source_id:'a',start:0,end:4,timeline_start:.5,track_id:'lower'},{source_id:'b',start:0,end:1,timeline_start:1.5,track_id:'upper'}],subtitles:{a:[],b:[]},voiceovers:[]};
  validateEdit(p.sources,p.clips,p.subtitles,p.tracks);
  const previous=process.env.CUTCCC_EXPORT_ENCODER;process.env.CUTCCC_EXPORT_ENCODER='libx264';t.after(()=>{if(previous===undefined)delete process.env.CUTCCC_EXPORT_ENCODER;else process.env.CUTCCC_EXPORT_ENCODER=previous;});
  const output=path.join(root,'output');await fs.mkdir(output);
  const result=await render(p,output,async sid=>paths[sid],(cmd,args,cwd)=>capture(cmd,args,{cwd}),false,{resolution:'480p',fps:60});assert.ok(Math.abs(result.duration-4.5)<.05);assert.equal(result.fps,60);
  const pixel=at=>{const r=spawnSync('ffmpeg',['-v','error','-ss',String(at),'-i',path.join(output,'video.mp4'),'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','-'],{windowsHide:true});assert.equal(r.status,0);return [...r.stdout];};
  const black=pixel(.1),red=pixel(1),blue=pixel(2),again=pixel(3);
  assert.ok(black[0]<10&&black[2]<10);assert.ok(red[0]>200&&red[2]<30);assert.ok(blue[2]>200&&blue[0]<30);assert.ok(again[0]>200&&again[2]<30);
});
