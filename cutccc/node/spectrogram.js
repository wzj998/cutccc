import { launch, stopProcess } from "./processes.js";
import { APIError } from "./editing.js";

export const SPECTROGRAM_VERSION = 2;
export const SPECTROGRAM_TILE_SECONDS = 20;
export function spectrumRegion(tile, duration) {
  if (tile === "overview") return {start: 0, duration, width: 2048, height: 512};
  if (typeof tile !== "string" || !/^(0|[1-9]\d*)$/.test(tile)) throw new APIError("Invalid spectrogram tile");
  const index = Number(tile), start = index * SPECTROGRAM_TILE_SECONDS;
  if (!Number.isSafeInteger(index) || start >= duration) throw new APIError("Spectrogram tile is outside the source");
  return {start, duration: Math.min(SPECTROGRAM_TILE_SECONDS, duration - start), width: 1024, height: 512};
}
export function generateSpectrogram(file, region, processes) {
  return new Promise((resolve, reject) => {
    // Keep frequency rows linear here; the browser applies an exact 80–8000 Hz log axis.
    const filter = `aformat=channel_layouts=mono,aresample=16000,apad=whole_dur=${region.duration},atrim=duration=${region.duration},asetpts=PTS-STARTPTS,showspectrumpic=s=${region.width}x${region.height}:legend=0:color=magma:scale=log:fscale=lin:start=80:stop=8000:win_func=hann:drange=70:limit=-10`;
    const child = launch("ffmpeg", ["-nostdin", "-v", "error", "-ss", String(region.start), "-t", String(region.duration), "-i", file,
      "-filter_complex", `[0:a:0]${filter}[spectrum]`, "-map", "[spectrum]", "-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"]);
    processes.add(child);
    const buffers = [];
    let size = 0, error = "", failure = null;
    const timer = setTimeout(() => { failure = new Error("Spectrogram extraction timed out"); void stopProcess(child); }, 180000);
    child.stdout.on("data", buffer => {
      size += buffer.length;
      if (size <= 4 * 1024 * 1024) buffers.push(buffer);
      else { failure = new Error("Spectrogram image exceeds limit"); void stopProcess(child); }
    });
    child.stderr.on("data", buffer => { error = (error + buffer.toString()).slice(-4000); });
    child.once("error", e => { clearTimeout(timer); processes.delete(child); reject(e); });
    child.once("close", code => {
      clearTimeout(timer); processes.delete(child);
      if (failure || code !== 0) { reject(failure || new Error(`Spectrogram extraction failed: ${error}`)); return; }
      const png = Buffer.concat(buffers);
      if (!png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) reject(new Error("Invalid spectrogram image"));
      else resolve(png);
    });
  });
}
