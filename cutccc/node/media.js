import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { capture } from "./processes.js";
import { toAss } from "./subtitle-ass.js";
import {
  APIError,
  clipFrames,
  FPS,
  mapSubtitles,
  outputDuration,
  toSrt,
  validateVoiceovers,
} from "./editing.js";

export async function probe(file) {
  let data;
  try {
    data = JSON.parse(
      (
        await capture("ffprobe", [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          file,
        ])
      ).stdout,
    );
  } catch (e) {
    throw new APIError(
      `Cannot read this video; check its format and contents (${e.message})`,
    );
  }
  const video = data.streams?.find(
    (s) => s.codec_type === "video" && !s.disposition?.attached_pic,
  );
  if (!video) throw new APIError("The editor requires a video stream");
  const duration = Number(data.format?.duration || video.duration || 0);
  if (!Number.isFinite(duration) || duration < 1 / FPS)
    throw new APIError("Video duration is invalid");
  let width = Number(video.width),
    height = Number(video.height);
  const rotation = Number(
    video.side_data_list?.find((s) => "rotation" in s)?.rotation || 0,
  );
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  return {
    duration,
    width,
    height,
    has_audio: data.streams.some((s) => s.codec_type === "audio"),
  };
}
export async function thumbnail(source, target) {
  await capture("ffmpeg", [
    "-nostdin",
    "-v",
    "error",
    "-i",
    source,
    "-frames:v",
    "1",
    "-vf",
    "scale=480:-2",
    "-y",
    target,
  ]);
}
export function defaultModelsDir() {
  return path.resolve(
    process.env.CUTCCC_MODELS_DIR ||
      path.join(os.homedir(), ".cache", "cutccc", "models"),
  );
}
export async function validateModels(root) {
  for (const name of ["Qwen3-ASR-1.7B", "Qwen3-ForcedAligner-0.6B"]) {
    const folder = path.resolve(root, name);
    let weights = ["model.safetensors"];
    try {
      const index = JSON.parse(
        await fs.readFile(
          path.join(folder, "model.safetensors.index.json"),
          "utf8",
        ),
      );
      weights = [...new Set(Object.values(index.weight_map))];
      if (!weights.length) throw new APIError(`Empty weight index: ${name}`);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    for (const name of [
      "config.json",
      "preprocessor_config.json",
      "tokenizer_config.json",
      "vocab.json",
      "merges.txt",
      ...weights,
    ]) {
      if (
        typeof name !== "string" ||
        path.dirname(path.resolve(folder, name)) !== folder
      )
        throw new APIError("Invalid checkpoint filename");
      const stat = await fs.stat(path.join(folder, name));
      if (!stat.isFile() || !stat.size)
        throw new APIError(`Missing model file: ${name}`);
    }
  }
}
export async function render(
  project,
  folder,
  sourcePath,
  runProcess,
  burnSubtitles = true,
) {
  const clips = project.clips,
    sources = new Map(project.sources.map((s) => [s.id, s]));
  if (!clips.length)
    throw new APIError("Add at least one clip before exporting");
  const encoder = process.env.CUTCCC_EXPORT_ENCODER || "libx264",
    hw = process.env.CUTCCC_EXPORT_HWACCEL || "";
  if (!["libx264", "h264_nvenc"].includes(encoder))
    throw new APIError("CUTCCC_EXPORT_ENCODER must be libx264 or h264_nvenc");
  if (!["", "cuda"].includes(hw))
    throw new APIError("CUTCCC_EXPORT_HWACCEL must be empty or cuda");
  const voices = project.voiceovers || [];
  validateVoiceovers(project.sources, clips, voices);
  const first = sources.get(clips[0].source_id),
    scale = Math.min(1, 1920 / Math.max(first.width, first.height));
  const width = Math.max(2, Math.round((first.width * scale) / 2) * 2),
    height = Math.max(2, Math.round((first.height * scale) / 2) * 2);
  const args = ["-nostdin", "-v", "error", "-y"],
    filters = [];
  for (const [i, c] of clips.entries()) {
    if (hw) args.push("-hwaccel", hw);
    args.push(
      "-ss",
      String(c.start),
      "-t",
      String(c.end - c.start),
      "-i",
      await sourcePath(c.source_id),
    );
    const frames = clipFrames(c),
      duration = frames / FPS;
    filters.push(
      `[${i}:v:0]trim=start=0:end=${c.end - c.start},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames},setpts=PTS-STARTPTS[v${i}]`,
    );
    if (sources.get(c.source_id).has_audio)
      filters.push(
        `[${i}:a:0]atrim=start=0:end=${c.end - c.start},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration}[a${i}]`,
      );
    else
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[a${i}]`,
      );
  }
  filters.push(
    clips.map((_, i) => `[v${i}][a${i}]`).join("") +
      `concat=n=${clips.length}:v=1:a=1[vcat][acat]`,
  );
  let audio = "[acat]";
  if (voices.length) {
    const ranges = [];
    for (const [j, v] of voices.entries()) {
      const source = sources.get(v.source_id),
        index = clips.length + j;
      args.push("-i", await sourcePath(v.source_id));
      ranges.push(`between(t,${v.start},${v.start + source.duration})`);
      filters.push(
        `[${index}:a:0]atrim=duration=${source.duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${v.volume ?? 1},adelay=${Math.round(v.start * 1000)}:all=1[voice${j}]`,
      );
    }
    filters.push(`[acat]volume=0.3:enable='${ranges.join("+")}'[ducked]`);
    filters.push(
      "[ducked]" +
        voices.map((_, j) => `[voice${j}]`).join("") +
        `amix=inputs=${voices.length + 1}:duration=first:normalize=0,alimiter=limit=0.98:level=false:latency=true[amixed]`,
    );
    audio = "[amixed]";
  }
  const cues = mapSubtitles(clips, project.subtitles, voices, project.sources);
  await fs.writeFile(path.join(folder, "subtitles.srt"), toSrt(cues), "utf8");
  await fs.writeFile(path.join(folder, "subtitles.ass"), toAss(cues, width, height), "utf8");
  let video = "[vcat]";
  if (burnSubtitles && cues.length) {
    filters.push(
      "[vcat]ass=subtitles.ass[vout]",
    );
    video = "[vout]";
  }
  await fs.writeFile(
    path.join(folder, "filters.txt"),
    filters.join(";\n"),
    "utf8",
  );
  const encoding =
    encoder === "h264_nvenc"
      ? [
          "-c:v",
          "h264_nvenc",
          "-preset",
          "p5",
          "-rc",
          "vbr",
          "-cq",
          "20",
          "-b:v",
          "0",
        ]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"];
  args.push(
    "-filter_complex_script",
    "filters.txt",
    "-map",
    video,
    "-map",
    audio,
    "-frames:v",
    String(clips.reduce((n, c) => n + clipFrames(c), 0)),
    "-t",
    String(outputDuration(clips)),
    ...encoding,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "video.mp4",
  );
  await runProcess("ffmpeg", args, folder, outputDuration(clips));
  const result = await probe(path.join(folder, "video.mp4"));
  if (Math.abs(result.duration - outputDuration(clips)) > 0.1)
    throw new Error("Export duration does not match the edit");
  return {
    duration: result.duration,
    width: result.width,
    height: result.height,
    subtitle_count: cues.length,
    project_revision: project.revision,
  };
}
