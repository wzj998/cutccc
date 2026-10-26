import test from "node:test";
import assert from "node:assert/strict";
import { WaveformPeaks } from "../cutccc/node/waveform.js";

test("waveform streaming preserves samples across odd byte chunks and final partial buckets", () => {
  const samples = [...Array(80).fill(0), ...Array(80).fill(16384), -32768];
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => pcm.writeInt16LE(value, index * 2));
  const waveform = new WaveformPeaks(1);
  for (let i = 0; i < pcm.length; i += 7) waveform.push(pcm.subarray(i, i + 7));
  const result = waveform.finish();
  assert.deepEqual(result.peaks, [0, .5, 1]);
  assert.deepEqual(result.rms, [0, .5, 1]);
  assert.equal(result.peaks_per_second, 100);
  assert.equal(result.audio_duration, samples.length / 8000);
});

test("waveform resolution is bounded for long sources and truncated PCM is rejected", () => {
  const long = new WaveformPeaks(7200);
  assert.ok(7200 * long.sampleRate / long.bucketSize <= 120000);
  const truncated = new WaveformPeaks(1);
  truncated.push(Buffer.from([1]));
  assert.throws(() => truncated.finish(), /Incomplete/);
});
