import test from "node:test";
import assert from "node:assert/strict";
import {
  clipFrames,
  mapSubtitles,
  outputDuration,
  timestamp,
  toSrt,
  validateEdit,
  validateVoiceovers,
} from "../cutccc/node/editing.js";
import { loopbackBase } from "../cutccc/node/mcp.js";
import { toAss, assText } from "../cutccc/node/subtitle-ass.js";
import { subtitleLayout } from "../cutccc/web/subtitle-style.js";

test("cue styles survive clipping and reuse while SRT stays plain text", () => {
  const style = {color: "#ffcc55", position: "top-center", fontSize: 40};
  const subtitles = {a: [{start: 1, end: 3, text: "Narration", style}]};
  const clips = [{source_id: "a", start: 2, end: 4}, {source_id: "a", start: 0, end: 2}];
  validateEdit([{id: "a", duration: 5}], clips, subtitles);
  const mapped = mapSubtitles(clips, subtitles);
  assert.deepEqual(mapped.map(c => c.style), [style, style]);
  mapped[0].style.color = "#ffffff";
  assert.equal(subtitles.a[0].style.color, "#ffcc55");
  assert.doesNotMatch(toSrt(mapped), /style|color|ffcc55/);
  assert.equal(subtitleLayout(style, 1080, 1920).alignment, 8);
  assert.match(toAss(mapped, 1080, 1920), /PlayResY: 1920/);
  assert.match(toAss(mapped, 1080, 1920), /\\pos\(540\.000,153\.600\)/);
  assert.match(assText("literal {\\b1}\nnext"), /\\\{/);
  assert.ok(assText("\\N").includes("\u2060"));
});

test("invalid style fields are rejected before project persistence", () => {
  for (const style of [null, [], {fontSize: NaN}, {fontSize: 0}, {fontFamily: "A,\\N"},
    {color: "red"}, {position: "outside"}, {bold: 1}, {marginX: 41}, {outlineWidth: -1}, {unknown: true}])
    assert.throws(() => validateEdit([{id: "a", duration: 5}], [], {a: [{start: 0, end: 1, text: "x", style}]}));
});

test("voiceover captions use output placement and retain their independent style", () => {
  const style = {position: "top-center", color: "#ffcc55"};
  const cues = mapSubtitles([{source_id: "scene", start: 20, end: 30}], {
    scene: [{start: 23, end: 25, text: "dialogue"}],
    voice: [{start: 0, end: 2, text: "narration", style}],
  }, [{source_id: "voice", start: 3.5}], [{id: "voice", duration: 2}]);
  assert.deepEqual(cues, [{start: 3, end: 5, text: "dialogue"}, {start: 3.5, end: 5.5, text: "narration", style}]);
});

test("existing source-clock subtitles survive reordering, reuse and clipping", () => {
  const sources = [
      { id: "a", duration: 10 },
      { id: "b", duration: 4 },
    ],
    clips = [
      { source_id: "b", start: 1, end: 3 },
      { source_id: "a", start: 4, end: 7 },
      { source_id: "b", start: 1, end: 3 },
    ];
  const subtitles = {
    a: [{ start: 3, end: 5, text: "甲" }],
    b: [{ start: 0, end: 2, text: "乙" }],
  };
  validateEdit(sources, clips, subtitles);
  assert.deepEqual(mapSubtitles(clips, subtitles), [
    { start: 0, end: 1, text: "乙" },
    { start: 2, end: 3, text: "甲" },
    { start: 5, end: 6, text: "乙" },
  ]);
  assert.equal(outputDuration(clips), 7);
});
test("frame rounding remains compatible with Python projects", () => {
  assert.equal(clipFrames({ start: 0, end: 1.15 }), 34); // round(34.5) in Python
  assert.equal(timestamp(59.9996), "00:01:00,000");
  assert.match(
    toSrt([{ start: 1.2, end: 1.8, text: "字幕" }]),
    /00:00:01,200 --> 00:00:01,800/,
  );
});
test("invalid edit ranges, subtitle overlap and nonfinite values are rejected", () => {
  for (const [start, end] of [
    [-1, 2],
    [2, 2],
    [3, 2],
    [0, 11],
    [NaN, 2],
    [0, Infinity],
  ])
    assert.throws(() =>
      validateEdit(
        [{ id: "a", duration: 10 }],
        [{ source_id: "a", start, end }],
        {},
      ),
    );
  assert.throws(() =>
    validateEdit([{ id: "a", duration: 10 }], [], {
      a: [
        { start: 0, end: 2, text: "a" },
        { start: 1, end: 3, text: "b" },
      ],
    }),
  );
});
test("voiceovers require audio and fit the output timeline", () => {
  const sources = [
      { id: "a", duration: 10, has_audio: false },
      { id: "v", duration: 2, has_audio: true },
    ],
    clips = [{ source_id: "a", start: 1, end: 6 }];
  validateVoiceovers(sources, clips, [
    { source_id: "v", start: 3, volume: 0.8 },
  ]);
  for (const voice of [
    { source_id: "a", start: 0 },
    { source_id: "missing", start: 0 },
    { source_id: "v", start: -1 },
    { source_id: "v", start: 4 },
    { source_id: "v", start: NaN },
    { source_id: "v", start: 0, volume: 3 },
  ])
    assert.throws(() => validateVoiceovers(sources, clips, [voice]));
});
test("MCP cannot bridge to remote servers or credential-bearing URLs", () => {
  for (const url of [
    "https://example.com",
    "http://0.0.0.0:1234",
    "http://user@localhost:1234",
    "http://localhost:1234/other",
  ])
    assert.throws(() => loopbackBase(url));
  assert.equal(
    loopbackBase("http://127.0.0.1:18765/"),
    "http://127.0.0.1:18765",
  );
});
