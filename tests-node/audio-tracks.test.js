import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {detachClipAudio,audioRange,audioDuration,projectDuration,audioResizeContext,resizedAudioClip,removeAudioClip} from '../cutccc/web/audio-tracks.js';
import {validateEdit,validateVoiceovers,mapSubtitles,outputDuration} from '../cutccc/node/editing.js';
import {copyTimelineItems,pasteTimelineItems} from '../cutccc/web/timeline-clipboard.js';
import {render} from '../cutccc/node/media.js';
import {capture} from '../cutccc/node/processes.js';
const fixture=()=>({id:'p',sources:[{id:'s',duration:10,width:48,height:80,has_audio:true}],
  clips:[{source_id:'s',start:1,end:3},{source_id:'s',start:5,end:7}],
  subtitles:{s:[{start:1.5,end:2.5,text:'speech'},{start:5.2,end:6,text:'later'}]},voiceovers:[]});
test('audio and video duration clocks agree exactly for fractional multi-clip timelines',()=>{
  const p=fixture();p.clips=[{start:29.6,end:53.171548},{start:55.912805,end:275.673954},{start:37.753282,end:256.895985}];
  assert.equal(projectDuration(p),outputDuration(p.clips));
});

test('audio separation creates independent trimmed audio, mutes only its video and maps captions once',()=>{
  const original=fixture(),{project:p,index}=detachClipAudio(original,0,'pair');
  assert.equal(index,0);assert.equal(p.clips[0].muted,true);assert.equal(p.clips[1].muted,undefined);
  assert.deepEqual(audioRange(p.voiceovers[0],p.sources[0]),{start:1,end:3});
  assert.equal(original.voiceovers.length,0);assert.equal(original.clips[0].muted,undefined);
  assert.deepEqual(mapSubtitles(p.clips,p.subtitles,p.voiceovers,p.sources).map(c=>[c.start,c.end,c.text]),[[.5,1.5,'speech'],[2.2,3,'later']]);
  assert.throws(()=>detachClipAudio(p,0,'duplicate'),/已经分离/);
  validateEdit(p.sources,p.clips,p.subtitles);validateVoiceovers(p.sources,p.clips,p.voiceovers);
});
test('removing video retains separated audio and captions; deleting audio can retain captions without a ghost track',()=>{
  const {project:p}=detachClipAudio(fixture(),0,'pair');p.clips.splice(0,1);
  assert.equal(audioDuration(p.voiceovers[0],p.sources[0]),2);
  assert.ok(mapSubtitles(p.clips,p.subtitles,p.voiceovers,p.sources).some(c=>c.text==='speech'));
  const removed=removeAudioClip(p,0);assert.equal(removed.voiceovers.length,0);
  assert.ok(removed.subtitles.s.some(c=>c.text==='speech'&&c.timeline_offset!==undefined));
  assert.ok(mapSubtitles(removed.clips,removed.subtitles,[],removed.sources).some(c=>c.text==='speech'));
  validateEdit(removed.sources,removed.clips,removed.subtitles);
});
test('audio-only output duration, independent copy/paste, and source-bounded edge trims',()=>{
  const {project:p}=detachClipAudio(fixture(),0,'pair');p.clips=[];p.voiceovers[0].start=3;
  assert.equal(projectDuration(p),5);validateVoiceovers(p.sources,p.clips,p.voiceovers);
  const copied=copyTimelineItems(p,'voice',0),pasted=pasteTimelineItems(p,copied,4);
  assert.equal(pasted.project.voiceovers.length,2);assert.equal(projectDuration(pasted.project),6);
  assert.deepEqual(audioRange(pasted.project.voiceovers[1],p.sources[0]),{start:1,end:3});
  for(const edge of ['start','end'])for(const delta of [-100,100]){
    const v=resizedAudioClip(audioResizeContext(p,0,edge),delta),r=audioRange(v,p.sources[0]);
    assert.ok(v.start>=0&&r.start>=0&&r.end<=10&&r.end-r.start>=1/30-1e-9);
    validateVoiceovers(p.sources,[],[v]);
  }
  assert.throws(()=>validateVoiceovers(p.sources,[],[{...p.voiceovers[0],source_end:11}]),/trim/);
});

const hasFFmpeg=spawnSync('ffmpeg',['-version'],{windowsHide:true}).status===0;
test('real exports use the selected audio range, mute paired video, and retain audio-only exports',{skip:!hasFFmpeg},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cutccc-audio-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'source.mkv');
  await capture('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=48x80:r=30:d=2','-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=1','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=1','-filter_complex','[1:a][2:a]concat=n=2:v=0:a=1[a]','-map','0:v','-map','[a]','-c:v','ffv1','-c:a','pcm_s16le',file]);
  const p={id:'p',sources:[{id:'s',duration:2,width:48,height:80,has_audio:true}],clips:[{source_id:'s',start:0,end:1.5,muted:true,audio_link:'pair'}],
    subtitles:{s:[]},voiceovers:[{source_id:'s',start:0,source_start:1,source_end:1.5,volume:1,detached:true,link_id:'pair'}]};
  const run=(cmd,args,cwd)=>capture(cmd,args,{cwd});
  const previous=process.env.CUTCCC_EXPORT_ENCODER;process.env.CUTCCC_EXPORT_ENCODER='libx264';
  t.after(()=>{if(previous===undefined)delete process.env.CUTCCC_EXPORT_ENCODER;else process.env.CUTCCC_EXPORT_ENCODER=previous;});
  const output=path.join(root,'video');await fs.mkdir(output);
  const result=await render(p,output,async()=>file,run,false,{fps:30,resolution:'480p'});
  assert.ok(Math.abs(result.duration-1.5)<.05);
  function samples(at,length){const r=spawnSync('ffmpeg',['-v','error','-ss',String(at),'-i',path.join(output,'video.mp4'),'-t',String(length),'-vn','-ac','1','-ar','48000','-f','f32le','-'],{windowsHide:true,maxBuffer:2e6});assert.equal(r.status,0);return Array.from({length:r.stdout.length/4},(_,i)=>r.stdout.readFloatLE(i*4));}
  const a=samples(.1,.3);let crossings=0;for(let i=1;i<a.length;i++)if(a[i-1]<=0&&a[i]>0)crossings++;
  assert.ok(crossings/.3>850&&crossings/.3<910,'Expected the second (880 Hz) source section');
  const silent=samples(1.05,.3);assert.ok(Math.sqrt(silent.reduce((n,x)=>n+x*x,0)/silent.length)<.002,'Paired video original audio must stay muted');
  p.clips=[];p.voiceovers[0].start=.25;const audioOnly=path.join(root,'audio-only');await fs.mkdir(audioOnly);
  const pure=await render(p,audioOnly,async()=>file,run,false,{fps:30,resolution:'480p'});
  assert.ok(Math.abs(pure.duration-projectDuration(p))<.05);assert.equal(pure.width,48);
});
