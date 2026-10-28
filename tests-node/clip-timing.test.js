import test from "node:test";
import assert from "node:assert/strict";
import {clipResizeContext, resizedClipRange} from "../cutccc/web/caption-timing.js";
import {validateEdit, validateVoiceovers, mapSubtitles} from "../cutccc/node/editing.js";

const project = () => ({id:"p", sources:[{id:"s",duration:30,has_audio:true}],
  clips:[{source_id:"s",start:10,end:20},{source_id:"s",start:10,end:20}],
  subtitles:{s:[{start:17,end:19,text:"Original speech"}]},voiceovers:[]});

test("clip edge trims extend to source boundaries and retain at least one frame", () => {
  const p=project();
  for (const edge of ["start","end"]) {
    const c=clipResizeContext(p,0,edge);
    for (const delta of [-100,100]) {
      const range=resizedClipRange(c,delta);
      assert.ok(range.start>=0 && range.end<=30);
      assert.ok(range.end-range.start>=1/30-1e-10);
      validateEdit(p.sources,[range,...p.clips.slice(1)],p.subtitles);
    }
    assert.deepEqual(resizedClipRange(c,0),p.clips[0]);
  }
  assert.equal(resizedClipRange(clipResizeContext(p,0,"start"),-100).start,0);
  assert.equal(resizedClipRange(clipResizeContext(p,0,"end"),100).end,30);
});

test("trimming one occurrence clips its captions and ripples later source captions without editing their text", () => {
  const p=project(),before=structuredClone(p);
  p.clips[0]=resizedClipRange(clipResizeContext(p,0,"end"),-2);
  const cues=mapSubtitles(p.clips,p.subtitles);
  assert.deepEqual(cues.map(c=>[c.start,c.end,c.text]),[[7,8,"Original speech"],[15,17,"Original speech"]]);
  assert.deepEqual(p.subtitles,before.subtitles);
  assert.deepEqual(p.clips[1],before.clips[1]);
});

test("trim bounds keep fixed-time audio and independently placed captions within the output", () => {
  const p=project();p.sources.push({id:"v",duration:5,has_audio:true});p.subtitles.v=[];
  p.voiceovers=[{source_id:"v",start:12,volume:1}];
  p.subtitles.s.push({start:0,end:2,text:"independent",timeline_offset:16});
  for (const edge of ["start","end"]) {
    const range=resizedClipRange(clipResizeContext(p,0,edge),edge==="start"?100:-100);
    assert.ok(Math.round((range.end-range.start)*30)/30+10>=18);
    validateEdit(p.sources,[range,p.clips[1]],p.subtitles);
    validateVoiceovers(p.sources,[range,p.clips[1]],p.voiceovers);
  }
});

test("fractional source endpoints survive unchanged gestures and clamp without crossing the source end", () => {
  const p=project();p.sources[0].duration=20.123456789;p.clips[0]={source_id:"s",start:10.012345678,end:20.123456789};
  const c=clipResizeContext(p,0,"end");
  assert.deepEqual(resizedClipRange(c,0),p.clips[0]);
  assert.ok(resizedClipRange(c,100).end<=p.sources[0].duration);
  assert.equal(clipResizeContext(p,3,"end"),null);
  assert.equal(clipResizeContext(p,0,"middle"),null);
  assert.equal(clipResizeContext(null,0,"start"),null);
});
