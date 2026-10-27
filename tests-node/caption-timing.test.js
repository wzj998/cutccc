import test from "node:test";
import assert from "node:assert/strict";
import { captionResizeContext, resizedCaptionTime } from "../cutccc/web/caption-timing.js";
import { validateEdit, mapSubtitles } from "../cutccc/node/editing.js";

test("resizing shifted captions changes one source boundary and respects neighbors", () => {
  const p = {id:"p", sources:[{id:"s",duration:30}], clips:[{source_id:"s",start:10,end:20}],
    subtitles:{s:[{start:10,end:11,text:"A"},{start:12,end:15,text:"B",shift:2},{start:16,end:18,text:"C"}]}};
  const mapped = {sourceId:"s",index:1,occurrence:"clip:0:1",start:4,end:7};
  let c = captionResizeContext(p,mapped,"end");
  p.subtitles.s[1].end = resizedCaptionTime(c,20);
  assert.equal(p.subtitles.s[1].end,16);
  assert.equal(p.subtitles.s[1].start,12);
  assert.equal(p.subtitles.s[1].shift,2);
  validateEdit(p.sources,p.clips,p.subtitles);
  assert.equal(mapSubtitles(p.clips,p.subtitles).find(s=>s.text==="B").end,8);
  p.subtitles.s[1].end=15;
  c=captionResizeContext(p,mapped,"start");
  assert.equal(resizedCaptionTime(c,-100),11);
  assert.ok(resizedCaptionTime(c,100)<=15-1/30+1e-9);
});

test("resizing clipped/reused captions and voice captions preserves output offsets", () => {
  const p={id:"p",sources:[{id:"s",duration:30},{id:"v",duration:4}],
    clips:[{source_id:"s",start:10,end:20},{source_id:"s",start:10,end:20}],
    subtitles:{s:[{start:8,end:13,text:"clipped"}],v:[{start:1,end:3,text:"voice"}]},
    voiceovers:[{source_id:"v",start:8,volume:1}]};
  const c=captionResizeContext(p,{sourceId:"s",index:0,occurrence:"clip:1:0",start:10,end:13},"start");
  assert.equal(resizedCaptionTime(c,1),11);
  assert.equal(resizedCaptionTime(c,-10),10);
  const voice=captionResizeContext(p,{sourceId:"v",index:0,occurrence:"voice:0:0",start:9,end:11},"end");
  assert.equal(resizedCaptionTime(voice,10),4);
  assert.equal(p.voiceovers[0].start,8);
  assert.equal(captionResizeContext(p,null,"end"),null);
});
