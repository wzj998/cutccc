import { launch, stopProcess } from "./processes.js";

export const WAVEFORM_VERSION = 1;
export class WaveformPeaks {
  constructor(duration, sampleRate = 8000) {
    this.sampleRate = sampleRate;
    this.bucketSize = Math.max(1, Math.ceil(sampleRate / Math.min(100, 120000 / Math.max(1, duration))));
    this.peaks = []; this.rms = [];
    this.samples = 0; this.count = 0; this.peak = 0; this.power = 0; this.peakMax = 0;
    this.carry = null;
  }
  sample(value) {
    const amplitude = Math.abs(value / 32768);
    this.peak = Math.max(this.peak, amplitude);
    this.peakMax = Math.max(this.peakMax, amplitude);
    this.power += amplitude * amplitude;
    this.count++; this.samples++;
    if (this.count === this.bucketSize) this.flush();
  }
  flush() {
    if (!this.count) return;
    if (this.peaks.length >= 250000) throw new Error("Audio duration exceeds waveform metadata limits");
    this.peaks.push(Math.round(this.peak * 10000) / 10000);
    this.rms.push(Math.round(Math.sqrt(this.power / this.count) * 10000) / 10000);
    this.count = 0; this.peak = 0; this.power = 0;
  }
  push(buffer) {
    let i = 0;
    if (this.carry !== null && buffer.length) {
      const value = this.carry | (buffer[0] << 8);
      this.sample(value >= 32768 ? value - 65536 : value);
      this.carry = null; i = 1;
    }
    for (; i + 1 < buffer.length; i += 2) this.sample(buffer.readInt16LE(i));
    if (i < buffer.length) this.carry = buffer[i];
  }
  finish() {
    if (this.carry !== null) throw new Error("Incomplete waveform audio sample");
    this.flush();
    return {version: WAVEFORM_VERSION, sample_rate: this.sampleRate,
      peaks_per_second: this.sampleRate / this.bucketSize,
      audio_duration: this.samples / this.sampleRate, peak_max: this.peakMax,
      peaks: this.peaks, rms: this.rms};
  }
}

export function generateWaveform(file, duration, processes) {
  return new Promise((resolve, reject) => {
    const peaks = new WaveformPeaks(duration);
    const child = launch("ffmpeg", ["-nostdin", "-v", "error", "-i", file,
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]);
    processes.add(child);
    let error = "", failure = null;
    const timer = setTimeout(() => { failure = new Error("Waveform extraction timed out"); void stopProcess(child); }, 180000);
    child.stdout.on("data", buffer => {
      if (failure) return;
      try { peaks.push(buffer); } catch (e) { failure = e; void stopProcess(child); }
    });
    child.stderr.on("data", buffer => { error = (error + buffer.toString()).slice(-4000); });
    child.once("error", e => { clearTimeout(timer); processes.delete(child); reject(e); });
    child.once("close", code => {
      clearTimeout(timer); processes.delete(child);
      if (failure || code !== 0) { reject(failure || new Error(`Waveform extraction failed: ${error}`)); return; }
      try { resolve(peaks.finish()); } catch (e) { reject(e); }
    });
  });
}
