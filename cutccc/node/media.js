import fs from "node:fs/promises";
import {audioRange,audioDuration,projectDuration} from "../web/audio-tracks.js";
import os from "node:os";
import path from "node:path";
import { capture } from "./processes.js";
import { toAss, wrapExportCues } from "./subtitle-ass.js";
import { exportProfile } from "../web/export-options.js";
import {gpuRotation, geometryFilter, clipVideoFilter, GPU_INPUT_ARGS} from "./export-video-filter.js";
import {
  APIError,
  clipFrames,
  FPS,
  mapSubtitles,
  outputDuration,
  toSrt,
  validateVoiceovers,
} from "./editing.js";

export async function probe(file, details = false) {
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
    fps: (() => { const [n, d] = (video.avg_frame_rate || "0/1").split("/").map(Number); return d ? n / d : 0; })(),
    has_audio: data.streams.some((s) => s.codec_type === "audio"),
    ...(details ? {video} : {}),
  };
}
const gpuScaleChecks = new Map();
async function canScaleOnGpu(file, clip, width, height, fps, rotation) {
  const stat = await fs.stat(file);
  const key = JSON.stringify([file,stat.size,stat.mtimeMs,width,height,fps,rotation]);
  if (gpuScaleChecks.has(key)) return gpuScaleChecks.get(key);
  const check = capture("ffmpeg",["-nostdin","-v","error",...GPU_INPUT_ARGS,"-ss",String(clip.start),"-i",file,
    "-an","-sn","-dn","-vf",`fps=${fps},${geometryFilter(width,height,rotation)}`,"-frames:v","1","-f","null","-"],
    {timeout:20000,maxBytes:1024*1024}).then(()=>({supported:true}),error=>({supported:false,reason:error.message.slice(-600)}));
  gpuScaleChecks.set(key,check);
  const result = await check;
  if (!result.supported) gpuScaleChecks.delete(key);
  while (gpuScaleChecks.size > 64) gpuScaleChecks.delete(gpuScaleChecks.keys().next().value);
  return result;
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
  options = {},
) {
  const clips = project.clips,
    sources = new Map(project.sources.map((s) => [s.id, s]));
  if (!clips.length && !(project.voiceovers || []).some(v=>v.detached))
    throw new APIError("Add at least one clip before exporting");
  const encoder = process.env.CUTCCC_EXPORT_ENCODER || "libx264",
    hw = process.env.CUTCCC_EXPORT_HWACCEL || "";
  if (!["libx264", "h264_nvenc"].includes(encoder))
    throw new APIError("CUTCCC_EXPORT_ENCODER must be libx264 or h264_nvenc");
  if (!["", "cuda"].includes(hw))
    throw new APIError("CUTCCC_EXPORT_HWACCEL must be empty or cuda");
  const voices = project.voiceovers || [];
  const audibleVoices = voices.filter(v => (v.volume ?? 1) > 0);
  validateVoiceovers(project.sources, clips, voices);
  const seconds=projectDuration(project);
  const profile = exportProfile(sources.get(clips[0]?.source_id || voices[0]?.source_id), options, seconds);
  const { width, height, fps } = profile;
  const args = ["-nostdin", "-v", "error", "-y"],
    filters = [];
  const paths = new Map(), metadata = new Map(), gpuChecks = new Map(), plans = [];
  for (const [i, c] of clips.entries()) {
    if (!paths.has(c.source_id)) paths.set(c.source_id,await sourcePath(c.source_id));
    const file = paths.get(c.source_id);
    let rotation = null, fallback = null;
    if (hw === "cuda" && process.env.CUTCCC_EXPORT_GPU_SCALE !== "0") {
      if (!metadata.has(file)) metadata.set(file,await probe(file,true));
      const candidate = gpuRotation(metadata.get(file).video);
      if (candidate !== null) {
        if (!gpuChecks.has(file)) gpuChecks.set(file,await canScaleOnGpu(file,c,width,height,fps,candidate));
        const check = gpuChecks.get(file);
        if (check.supported) rotation = candidate; else fallback = check.reason;
      }
    }
    if (rotation !== null) args.push(...GPU_INPUT_ARGS);
    else if (hw && !fallback) args.push("-hwaccel", hw);
    plans.push({source_id:c.source_id,gpu_scaling:rotation !== null,...(fallback ? {fallback} : {})});
    args.push(
      "-ss",
      String(c.start),
      "-t",
      String(c.end - c.start),
      "-i",
      file,
    );
    const frames = clipFrames(c) * fps / FPS,
      duration = clipFrames(c) / FPS;
    filters.push(
      `[${i}:v:0]${clipVideoFilter(c,width,height,fps,frames,rotation)}[v${i}]`,
    );
    if (sources.get(c.source_id).has_audio && !c.muted)
      filters.push(
        `[${i}:a:0]atrim=start=0:end=${c.end - c.start},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration}[a${i}]`,
      );
    else
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[a${i}]`,
      );
  }
  if(clips.length) {
    filters.push(clips.map((_, i) => `[v${i}][a${i}]`).join("") + `concat=n=${clips.length}:v=1:a=1[vcat][acat]`);
    filters.push(`[vcat]tpad=stop_mode=add:color=black:stop_duration=${Math.max(0,seconds-outputDuration(clips)).toFixed(6)},trim=duration=${seconds}[vbase]`);
    filters.push(`[acat]apad,atrim=duration=${seconds}[abase]`);
  } else {
    filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${seconds}[vbase]`);
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${seconds}[abase]`);
  }
  let audio = "[abase]";
  if (audibleVoices.length) {
    const ranges = [];
    for (const [j, v] of audibleVoices.entries()) {
      const source = sources.get(v.source_id),
        index = clips.length + j;
      const range=audioRange(v,source),length=audioDuration(v,source);
      args.push("-ss",String(range.start),"-t",String(length),"-i", await sourcePath(v.source_id));
      if(!v.detached)ranges.push(`between(t,${v.start},${v.start + length})`);
      filters.push(
        `[${index}:a:0]atrim=duration=${length},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${v.volume ?? 1},adelay=${Math.round(v.start * 1000)}:all=1[voice${j}]`,
      );
    }
    filters.push(ranges.length?`[abase]volume=0.3:enable='${ranges.join("+")}'[ducked]`:"[abase]anull[ducked]");
    filters.push(
      "[ducked]" +
        audibleVoices.map((_, j) => `[voice${j}]`).join("") +
        `amix=inputs=${audibleVoices.length + 1}:duration=first:normalize=0,alimiter=limit=0.98:level=false:latency=true[amixed]`,
    );
    audio = "[amixed]";
  }
  const cues = mapSubtitles(clips, project.subtitles, voices, project.sources);
  await fs.writeFile(path.join(folder, "subtitles.srt"), toSrt(cues), "utf8");
  await fs.writeFile(path.join(folder, "subtitles.ass"), toAss(wrapExportCues(cues,width,height), width, height), "utf8");
  let video = "[vbase]";
  if (burnSubtitles && cues.length) {
    filters.push(
      "[vbase]ass=subtitles.ass[vout]",
    );
    video = "[vout]";
  }
  await fs.writeFile(
    path.join(folder, "filters.txt"),
    filters.join(";\n"),
    "utf8",
  );
  let size = 0, attempts = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
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
            String(profile.cq),
            "-b:v",
            `${profile.bitrate}k`,
          ]
        : ["-c:v", "libx264", "-preset", "medium", "-crf", String(profile.cq)];
    encoding.push("-maxrate", `${profile.maxrate}k`, "-bufsize", `${profile.maxrate * 2}k`);
    const exportArgs = [...args,
      "-filter_complex_script",
      "filters.txt",
      "-map",
      video,
      "-map",
      audio,
      "-frames:v",
      String(Math.round(seconds*fps)),
      "-t",
      String(seconds),
      ...encoding,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      `${profile.audioBitrate}k`,
      ...(profile.audioChannels ? ["-ac",String(profile.audioChannels)] : []),
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      "video.mp4",
    ];
    await fs.writeFile(path.join(folder,"render-plan.json"),JSON.stringify({profile,clips:plans,early_fps:true,attempts},null,2));
    await runProcess("ffmpeg", exportArgs, folder, seconds);
    size = (await fs.stat(path.join(folder,"video.mp4"))).size;
    if (!profile.maxBytes || size < profile.maxBytes) break;
    if (attempt === 1) throw new APIError("样片仍超过30 MB，请分段导出。文件保留在任务目录中。");
    profile.bitrate = Math.floor(profile.bitrate * profile.targetBytes / size * .9);
    profile.maxrate = profile.bitrate;
    if (profile.bitrate < 80) throw new APIError("样片时长过长，请分段导出以保持可读画质。");
  }
  const result = await probe(path.join(folder, "video.mp4"));
  if (Math.abs(result.duration - seconds) > 0.1)
    throw new Error("Export duration does not match the edit");
  return {
    duration: result.duration,
    width: result.width,
    height: result.height,
    fps: result.fps,
    export_options: profile,
    file_size: size,
    processing: {gpu_scaled_clips:plans.filter(p=>p.gpu_scaling).length,early_fps:true,attempts},
    subtitle_count: cues.length,
    project_revision: project.revision,
  };
}
