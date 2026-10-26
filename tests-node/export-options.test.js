import test from "node:test";
import assert from "node:assert/strict";
import { exportOptions, exportProfile } from "../cutccc/web/export-options.js";

test("export defaults, resolution caps and bounded quality profiles", () => {
  assert.deepEqual(exportOptions(), { fps: 30, resolution: "1080p", quality: "balanced" });
  for (const options of [{ fps: 59.94 }, { fps: "60" }, { resolution: "8k" }, { quality: "lossless" }])
    assert.throws(() => exportOptions(options));
  const portrait = exportProfile({ width: 1520, height: 2704 }, { fps: 60 });
  assert.equal(portrait.height, 1920);
  assert.ok(portrait.width <= 1080 && portrait.width % 2 === 0);
  assert.ok(portrait.bitrate <= 4500);
  assert.deepEqual([exportProfile({ width: 640, height: 360 }).width, exportProfile({ width: 640, height: 360 }).height], [640, 360]);
  assert.ok(exportProfile({width:1920,height:1080},{quality:"compact"}).bitrate < exportProfile({width:1920,height:1080}).bitrate);
});
