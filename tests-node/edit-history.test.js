import test from "node:test";
import assert from "node:assert/strict";
import { EditHistory } from "../cutccc/web/edit-history.js";

test("history restores independent edit snapshots and invalidates divergent redo", () => {
  const history = new EditHistory();
  const original = {clips: [1, 2], subtitles: {a: [{text: "before"}]}};
  history.reset(original);
  const changed = structuredClone(original);
  changed.clips.pop();
  history.record(changed);
  changed.subtitles.a[0].text = "after";
  history.record(changed);
  assert.equal(history.undo().subtitles.a[0].text, "before");
  assert.deepEqual(history.undo(), original);
  assert.equal(history.dirty, false);
  assert.deepEqual(history.redo().clips, [1]);
  history.record({clips: [3], subtitles: {}});
  assert.equal(history.canRedo, false);
  history.reset({clips: [], subtitles: {}});
  assert.equal(history.canUndo, false);
});

test("continuous typing coalesces while separate fields and gestures remain separate", () => {
  const history = new EditHistory();
  history.reset({text: ""});
  history.record({text: "a"}, {group: "text", at: 1000});
  history.record({text: "ab"}, {group: "text", at: 1400});
  history.record({text: "abc"}, {group: "text", at: 1900});
  assert.equal(history.past.length, 1);
  history.breakGroup();
  history.record({text: "abcd"}, {group: "text", at: 2000});
  assert.equal(history.undo().text, "abc");
  assert.equal(history.undo().text, "");
});

test("saving retains undo and newer edits remain dirty after an earlier save finishes", () => {
  const history = new EditHistory();
  history.reset({value: 0});
  history.record({value: 1});
  history.record({value: 2});
  history.markSaved({value: 1});
  assert.equal(history.dirty, true);
  assert.equal(history.undo().value, 1);
  assert.equal(history.dirty, false);
  assert.equal(history.undo().value, 0);
  assert.equal(history.dirty, true);
  history.redo();
  history.markSaved({value: 1});
  assert.equal(history.redo().value, 2);
});

test("history is bounded by count and memory", () => {
  const history = new EditHistory(3, 1000);
  history.reset({value: 0});
  for (let value = 1; value <= 10; value++) history.record({value});
  assert.equal(history.past.length, 3);
  assert.equal(history.undo().value, 9);
  const bounded = new EditHistory(100, 100);
  bounded.reset({text: "x".repeat(100)});
  for (let n = 0; n < 10; n++) bounded.record({text: "x".repeat(100) + n});
  assert.equal(bounded.past.length, 1);
});
