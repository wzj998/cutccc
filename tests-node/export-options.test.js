import test from "node:test";
import assert from "node:assert/strict";
import { exportOptions, exportProfile } from "../cutccc/web/export-options.js";

test("export defaults, resolution caps and bounded quality profiles", () => {
  assert.deepEqual(exportOptions(), { preset:"standard", fps: 30, resolution: "1080p", quality: "balanced" });
  for (const options of [{ fps: 59.94 }, { fps: "60" }, { resolution: "8k" }, { quality: "lossless" }])
    assert.throws(() => exportOptions(options));
  const portrait = exportProfile({ width: 1520, height: 2704 }, { fps: 60 });
  assert.equal(portrait.height, 1920);
  assert.ok(portrait.width <= 1080 && portrait.width % 2 === 0);
  assert.ok(portrait.bitrate <= 4500);
  assert.deepEqual([exportProfile({ width: 640, height: 360 }).width, exportProfile({ width: 640, height: 360 }).height], [640, 360]);
  assert.ok(exportProfile({width:1920,height:1080},{quality:"compact"}).bitrate < exportProfile({width:1920,height:1080}).bitrate);
});
test("Feishu sample uses a duration budget, caps dimensions and rejects impractically long videos",()=>{
  const source={width:1520,height:2704};
  for(const seconds of [5,438,838,1200]){
    const p=exportProfile(source,{preset:'feishu',fps:60,resolution:'2160p',quality:'high'},seconds);
    assert.equal(p.fps,30);assert.ok(p.height<=768);assert.equal(p.audioBitrate,64);
    assert.ok(seconds*(p.maxrate+p.audioBitrate)*1000/8 < 27_500_000);
    assert.equal(p.maxBytes,30_000_000);
  }
  assert.ok(exportProfile(source,{preset:'feishu'},838).height<exportProfile(source,{preset:'feishu'},438).height);
  assert.throws(()=>exportProfile(source,{preset:'feishu'},0));
  assert.throws(()=>exportProfile(source,{preset:'feishu'},3600),/分段/);
  assert.throws(()=>exportOptions({preset:'unknown'}));
});
