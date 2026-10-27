// Shared by the browser, HTTP service and renderer. Timeline clocks remain 30 fps.
export const exportSchema = {
  preset: { type: "string", enum: ["standard", "feishu"], default: "standard" },
  fps: { type: "integer", enum: [30, 60], default: 30 },
  resolution: { type: "string", enum: ["480p", "720p", "1080p", "1440p", "2160p", "source"], default: "1080p" },
  quality: { type: "string", enum: ["compact", "balanced", "high"], default: "balanced" },
};
export function exportOptions(input = {}) {
  const result = {};
  for (const [key, spec] of Object.entries(exportSchema)) {
    const value = input[key] === undefined ? spec.default : input[key];
    if (!spec.enum.includes(value)) throw new Error(`Invalid ${key}: choose ${spec.enum.join(", ")}`);
    result[key] = value;
  }
  if (result.preset === "feishu") Object.assign(result, {fps:30,resolution:"480p",quality:"balanced"});
  return result;
}
export function exportProfile(source, input = {}, duration = 0) {
  const options = exportOptions(input);
  const sample = options.preset === "feishu";
  if (sample && (!Number.isFinite(duration) || duration <= 0)) throw new Error("样片需要有效的视频时长。");
  const budget = sample ? Math.min(2500,Math.floor(27_500_000 * 8 / duration / 1000 - 64 - 12)) : 0;
  if (sample && budget < 80) throw new Error("视频过长，无法生成清晰且小于30 MB的样片，请分段导出。");
  const edge = sample ? (budget >= 350 ? 768 : budget >= 180 ? 640 : 480) : { "480p": 854, "720p": 1280, "1080p": 1920, "1440p": 2560, "2160p": 3840, source: Infinity }[options.resolution];
  const scale = Math.min(1, edge / Math.max(source.width, source.height));
  const width = Math.max(2, Math.floor(source.width * scale / 2) * 2);
  const height = Math.max(2, Math.floor(source.height * scale / 2) * 2);
  const factor = { compact: 0.6, balanced: 1, high: 1.8 }[options.quality];
  const bitrate = sample ? budget : Math.round(Math.max(400, 3000 * width * height / (1920 * 1080) * (options.fps === 60 ? 1.5 : 1) * factor));
  return { ...options, width, height, bitrate, maxrate: sample ? bitrate : Math.round(bitrate * 1.25),
    audioBitrate: sample ? 64 : options.quality === "high" ? 192 : 128,
    ...(sample ? {audioChannels:1,targetBytes:27_500_000,maxBytes:30_000_000} : {}),
    cq: { compact: 27, balanced: 23, high: 19 }[options.quality] };
}
