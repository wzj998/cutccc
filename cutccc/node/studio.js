import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { constants } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  APIError,
  identifier,
  outputDuration,
  titleText,
  validateEdit,
  validateVoiceovers,
} from "./editing.js";
import {
  defaultModelsDir,
  probe,
  render,
  thumbnail,
  validateModels,
} from "./media.js";
import { launch, stopProcess } from "./processes.js";
import { generateWaveform, WAVEFORM_VERSION } from "./waveform.js";
import { generateSpectrogram, spectrumRegion, SPECTROGRAM_VERSION } from "./spectrogram.js";
import { exportOptions, exportProfile } from "../web/export-options.js";
import { openFolder } from "./open-folder.js";
import {projectDuration} from "../web/audio-tracks.js";
import {getTracks,hasFreeVideo,videoDuration,materializeVideoPositions} from '../web/tracks.js';

const uuid = () => randomUUID().replaceAll("-", "");
const now = () => Date.now() / 1000;
const expand = (value) =>
  value === "~"
    ? os.homedir()
    : value.startsWith("~/") || value.startsWith("~\\")
      ? path.join(os.homedir(), value.slice(2))
      : value;
const exists = async (file) => {
  try {
    await fs.access(file);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
};
export const defaultDataDir = () =>
  process.env.CUTCCC_DATA_DIR ||
  path.join(os.homedir(), ".local", "share", "cutccc");
export class Studio {
  static async create({
    dataDir = defaultDataDir(),
    modelsDir = defaultModelsDir(),
    inferencePython,
  } = {}) {
    const studio = new Studio();
    studio.root = path.resolve(expand(dataDir));
    studio.models = path.resolve(expand(modelsDir));
    studio.python =
      inferencePython || process.env.CUTCCC_INFERENCE_PYTHON || "python";
    studio.closed = false;
    studio.mutation = Promise.resolve();
    studio.queue = Promise.resolve();
    studio.processes = new Set();
    studio.waveformTasks = new Map();
    studio.waveformQueue = Promise.resolve();
    await fs.mkdir(studio.root, { recursive: true });
    await studio.acquireLock();
    try {
      await fs.mkdir(path.join(studio.root, "projects"), { recursive: true });
      await fs.mkdir(path.join(studio.root, "jobs"), { recursive: true });
      for (const job of await studio.allJobs())
        if (["queued", "running"].includes(job.status))
          await studio.write(studio.jobDir(job.id, "job.json"), {
            ...job,
            status: "failed",
            message: "Server restarted; previous task was interrupted",
            finished_at: now(),
          });
      return studio;
    } catch (e) {
      await studio.releaseLock();
      throw e;
    }
  }
  async acquireLock() {
    this.lockDir = path.join(this.root, ".node-studio.lock");
    this.owner = { pid: process.pid, nonce: uuid(), created_at: now() };
    const acquire = async () => {
      await fs.mkdir(this.lockDir);
      await fs.writeFile(
        path.join(this.lockDir, "owner.json"),
        JSON.stringify(this.owner),
        { flag: "wx" },
      );
    };
    try {
      await acquire();
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const recovery = path.join(this.root, ".node-studio.recovery");
    try {
      await fs.mkdir(recovery);
    } catch (e) {
      if (e.code === "EEXIST")
        throw new Error(
          "This data directory is already used by another cutccc server",
        );
      throw e;
    }
    try {
      let owner;
      try {
        owner = JSON.parse(
          await fs.readFile(path.join(this.lockDir, "owner.json"), "utf8"),
        );
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        if (Date.now() - (await fs.stat(this.lockDir)).mtimeMs < 10000)
          throw new Error(
            "This data directory is already used by another cutccc server",
          );
      }
      let alive = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 0)
        try {
          process.kill(owner.pid, 0);
          alive = true;
        } catch (e) {
          if (e.code !== "ESRCH") alive = true;
        }
      if (alive)
        throw new Error(
          "This data directory is already used by another cutccc server",
        );
      await fs.unlink(path.join(this.lockDir, "owner.json")).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
      await fs.rmdir(this.lockDir);
      await acquire();
    } finally {
      await fs.rmdir(recovery);
    }
  }
  async releaseLock() {
    const owner = await this.read(path.join(this.lockDir, "owner.json"));
    if (owner.nonce === this.owner.nonce) {
      await fs.unlink(path.join(this.lockDir, "owner.json"));
      await fs.rmdir(this.lockDir);
    }
  }
  async exclusive(fn) {
    const prior = this.mutation;
    let release;
    this.mutation = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async read(file) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT")
        throw new APIError("Project, source or job not found", 404);
      throw e;
    }
  }
  async write(file, value) {
    const temp = file + "." + uuid() + ".tmp";
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
    try {
      // Windows readers and antivirus scanners can briefly block replacement.
      // Retain the previous JSON until an atomic rename succeeds.
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(temp, file);
          break;
        } catch (error) {
          if (
            attempt >= 5 ||
            !["EPERM", "EACCES", "EBUSY"].includes(error.code)
          )
            throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 20 * 2 ** attempt),
          );
        }
      }
    } catch (e) {
      await fs.unlink(temp).catch(() => {});
      throw e;
    }
  }
  projectDir(id, ...rest) {
    return path.join(this.root, "projects", identifier(id), ...rest);
  }
  jobDir(id, ...rest) {
    return path.join(this.root, "jobs", identifier(id), ...rest);
  }
  getProject(id) {
    return this.read(this.projectDir(id, "project.json"));
  }
  async listProjects() {
    const projects = [];
    for (const d of await fs.readdir(path.join(this.root, "projects"), {
      withFileTypes: true,
    }))
      if (d.isDirectory() && /^[a-f0-9]{32}$/.test(d.name)) {
        if (!(await exists(this.projectDir(d.name, "project.json")))) continue;
        const p = await this.getProject(d.name);
        projects.push({
          id: p.id,
          title: p.title,
          updated_at: p.updated_at,
          revision: p.revision,
          source_count: p.sources.length,
          duration: projectDuration(p),
        });
      }
    return projects.sort((a, b) => b.updated_at - a.updated_at);
  }
  async createProject(title = "未命名项目") {
    title = titleText(title);
    return this.exclusive(async () => {
      const id = uuid();
      await fs.mkdir(this.projectDir(id, "media"), { recursive: true });
      const p = {
        id,
        title,
        revision: 1,
        updated_at: now(),
        sources: [],
        clips: [],
        subtitles: {},
        voiceovers: [],
      };
      await this.write(this.projectDir(id, "project.json"), p);
      return p;
    });
  }
  async save(p) {
    p.revision++;
    p.updated_at = now();
    await this.write(this.projectDir(p.id, "project.json"), p);
    return p;
  }
  async importPath(id, input, name) {
    await this.getProject(id);
    input = path.resolve(expand(input));
    if (!(await fs.stat(input).catch(() => null))?.isFile())
      throw new APIError("Input video does not exist", 404);
    const sid = uuid();
    name =
      path.basename((name || input).replaceAll("\\", "/")).slice(0, 160) ||
      "video.mp4";
    let ext = path.extname(name).toLowerCase();
    if (
      ![".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mts"].includes(ext)
    )
      ext = ".mp4";
    const target = this.projectDir(id, "media", sid + ext),
      thumb = this.projectDir(id, "media", sid + ".jpg");
    try {
      await fs.copyFile(input, target, constants.COPYFILE_EXCL);
      const metadata = await probe(target);
      await thumbnail(target, thumb);
      return await this.exclusive(async () => {
        const p = await this.getProject(id),
          source = {
            id: sid,
            name,
            file: path.basename(target),
            subtitle_version: 0,
            ...metadata,
          };
        p.sources.push(source);
        p.subtitles[sid] = [];
        const clip={source_id:sid,start:0,end:metadata.duration};
        const tracks=getTracks(p),hasDefault=tracks.some(t=>t.id==='video-main'&&t.type==='video');
        if(hasFreeVideo(p)||(p.tracks!==undefined&&!hasDefault)) {
          const start=videoDuration(p);materializeVideoPositions(p);
          let track=getTracks(p).find(t=>t.type==='video');
          if(!track){p.tracks||=[];track={id:'video-main',type:'video',name:'视频1'};p.tracks.push(track);}
          clip.track_id=track.id;clip.timeline_start=start;
        }
        p.clips.push(clip);
        validateEdit(p.sources, p.clips, p.subtitles,p.tracks);
        return this.save(p);
      });
    } catch (e) {
      await Promise.all([
        fs.unlink(target).catch(() => {}),
        fs.unlink(thumb).catch(() => {}),
      ]);
      throw e;
    }
  }
  async sourcePath(id, sid, { poster = false, preview = false } = {}) {
    identifier(sid);
    const p = await this.getProject(id),
      source = p.sources.find((s) => s.id === sid);
    if (!source) throw new APIError("Source not found", 404);
    const folder = this.projectDir(id, "media");
    let filename = poster ? sid + ".jpg" : source.file;
    if (
      preview &&
      !poster &&
      (await exists(path.join(folder, sid + ".preview.mp4")))
    )
      filename = sid + ".preview.mp4";
    const file = path.resolve(folder, filename);
    if (path.dirname(file) !== path.resolve(folder) || !(await exists(file)))
      throw new APIError("Source file not found", 404);
    const real = await fs.realpath(file),
      realFolder = await fs.realpath(folder);
    if (path.dirname(real) !== realFolder)
      throw new APIError("Source file not found", 404);
    return file;
  }
  async updateEdit(id, { revision, clips, subtitles, title, voiceovers, tracks }) {
    return this.exclusive(async () => {
      const p = await this.getProject(id);
      if (p.revision !== revision)
        throw new APIError(
          "Project changed in another client. Reload before saving.",
          409,
        );
      const selectedTracks=tracks===null?undefined:tracks===undefined?p.tracks:tracks;
      validateEdit(p.sources, clips, subtitles,selectedTracks);
      voiceovers = voiceovers ?? p.voiceovers ?? [];
      validateVoiceovers(p.sources, clips, voiceovers,selectedTracks);
      if (title !== undefined && title !== null) p.title = titleText(title);
      for (const s of p.sources)
        if (
          JSON.stringify(p.subtitles[s.id] || []) !==
          JSON.stringify(subtitles[s.id] || [])
        )
          s.subtitle_version++;
      p.clips = structuredClone(clips);
      if(selectedTracks===undefined)delete p.tracks;else p.tracks=structuredClone(selectedTracks);
      p.voiceovers = structuredClone(voiceovers);
      p.subtitles = Object.fromEntries(
        p.sources.map((s) => [s.id, structuredClone(subtitles[s.id] || [])]),
      );
      return this.save(p);
    });
  }
  async removeSource(id, sid, revision, removeUsed = false) {
    identifier(sid);
    if(typeof removeUsed!=="boolean")throw new APIError("remove_used must be boolean",422);
    return this.exclusive(async () => {
      const p = await this.getProject(id);
      if (p.revision !== revision) throw new APIError("Project changed in another client. Reload before saving.", 409);
      if (!p.sources.some(s => s.id === sid)) throw new APIError("Source not found", 404);
      if (!removeUsed && (p.clips.some(c => c.source_id === sid) || (p.voiceovers || []).some(v => v.source_id === sid)))
        throw new APIError("Remove the source from the timeline before removing it from the library");
      if ((await this.listJobs(id)).some(j => ["queued", "running"].includes(j.status)))
        throw new APIError("Wait for the project's active tasks before removing a source", 409);
      const before = structuredClone(p);
      p.clips = p.clips.filter(c => c.source_id !== sid);
      p.voiceovers = (p.voiceovers || []).filter(v => v.source_id !== sid);
      p.sources = p.sources.filter(s => s.id !== sid);
      delete p.subtitles[sid];
      validateEdit(p.sources, p.clips, p.subtitles,p.tracks);
      try { validateVoiceovers(p.sources, p.clips, p.voiceovers,p.tracks); }
      catch { throw new APIError("移除后，其他音频将超出剩余视频时长，请先调整这些音频。"); }
      const backups = this.projectDir(id, "backups");
      await fs.mkdir(backups, {recursive:true});
      await this.write(path.join(backups, `before-source-removal-${p.revision}-${uuid()}.json`), before);
      // Keep the files on disk so existing project backups remain recoverable.
      return this.save(p);
    });
  }
  async waveform(id, sid) {
    if (this.closed) throw new APIError("Server is shutting down", 503);
    const file = await this.sourcePath(id, sid);
    const project = await this.getProject(id), source = project.sources.find(s => s.id === sid);
    const stat = await fs.stat(file);
    const fingerprint = `${stat.size}:${stat.mtimeMs}:${source.duration}:${source.has_audio}`;
    const folder = this.projectDir(id, "waveforms"), cache = path.join(folder, sid + ".json");
    try {
      const data = JSON.parse(await fs.readFile(cache, "utf8"));
      if (data?.version === WAVEFORM_VERSION && data.fingerprint === fingerprint &&
          Number.isFinite(data.peaks_per_second) && data.peaks_per_second > 0 &&
          Array.isArray(data.peaks) && Array.isArray(data.rms) && data.peaks.length === data.rms.length) return data;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const key = `${id}:${sid}:${fingerprint}`;
    if (this.waveformTasks.has(key)) return this.waveformTasks.get(key);
    const task = this.waveformQueue.then(async () => {
      if (this.closed) throw new APIError("Server is shutting down", 503);
      const data = source.has_audio ? await generateWaveform(file, source.duration, this.processes)
        : {version: WAVEFORM_VERSION, sample_rate: 8000, peaks_per_second: 100, audio_duration: 0, peak_max: 0, peaks: [], rms: []};
      const result = {...data, source_id: sid, duration: source.duration, has_audio: source.has_audio, fingerprint};
      await fs.mkdir(folder, {recursive: true});
      await this.write(cache, result);
      return result;
    });
    this.waveformTasks.set(key, task);
    this.waveformQueue = task.catch(() => {});
    try { return await task; } finally { this.waveformTasks.delete(key); }
  }
  async spectrogram(id, sid, tile = "overview") {
    if (this.closed) throw new APIError("Server is shutting down", 503);
    const file = await this.sourcePath(id, sid);
    const source = (await this.getProject(id)).sources.find(s => s.id === sid);
    if (!source.has_audio) throw new APIError("Source has no audio track");
    const region = spectrumRegion(tile, source.duration);
    const stat = await fs.stat(file);
    const fingerprint = createHash("sha256").update(`${SPECTROGRAM_VERSION}:${stat.size}:${stat.mtimeMs}:${source.duration}`).digest("hex").slice(0, 20);
    const folder = this.projectDir(id, "spectrograms", `${sid}-${fingerprint}`);
    const cache = path.join(folder, `${tile}.png`);
    if ((await fs.stat(cache).catch(() => null))?.size > 32) return cache;
    const key = `spectrum:${id}:${sid}:${fingerprint}:${tile}`;
    if (this.waveformTasks.has(key)) return this.waveformTasks.get(key);
    const task = this.waveformQueue.then(async () => {
      if (this.closed) throw new APIError("Server is shutting down", 503);
      const image = await generateSpectrogram(file, region, this.processes);
      await fs.mkdir(folder, {recursive: true});
      const temporary = cache + "." + uuid() + ".tmp";
      try { await fs.writeFile(temporary, image); await fs.rename(temporary, cache); }
      finally { await fs.unlink(temporary).catch(() => {}); }
      return cache;
    });
    this.waveformTasks.set(key, task);
    this.waveformQueue = task.catch(() => {});
    try { return await task; } finally { this.waveformTasks.delete(key); }
  }
  getJob(id) {
    return this.read(this.jobDir(id, "job.json"));
  }
  async allJobs() {
    const jobs = [];
    for (const d of await fs.readdir(path.join(this.root, "jobs"), {
      withFileTypes: true,
    }))
      if (
        d.isDirectory() &&
        /^[a-f0-9]{32}$/.test(d.name) &&
        (await exists(this.jobDir(d.name, "job.json")))
      )
        jobs.push(await this.getJob(d.name));
    return jobs;
  }
  async listJobs(id) {
    await this.getProject(id);
    return (await this.allJobs())
      .filter((j) => j.project_id === id)
      .sort((a, b) => b.created_at - a.created_at);
  }
  async updateJob(id, changes) {
    return this.exclusive(async () => {
      const j = { ...(await this.getJob(id)), ...changes };
      await this.write(this.jobDir(id, "job.json"), j);
      return j;
    });
  }
  async submit(
    id,
    kind,
    { source_id, burn_subtitles = true, language = "auto", ...options } = {},
  ) {
    return this.exclusive(async () => {
      if (this.closed) throw new Error("Server is shutting down");
      const p = await this.getProject(id);
      if (kind === "transcribe") {
        if (!["auto", "Chinese", "English"].includes(language))
          throw new APIError("language must be auto, Chinese or English");
        await this.sourcePath(id, source_id);
        await validateModels(this.models);
        if (
          (await this.listJobs(id)).some(
            (j) =>
              j.kind === "transcribe" &&
              j.source_id === source_id &&
              ["queued", "running"].includes(j.status),
          )
        )
          throw new APIError(
            "A transcription task is already active for this source",
            409,
          );
      } else if (kind === "export") {
        try { options = exportOptions(options); }
        catch (e) { throw new APIError(e.message, 422); }
        validateEdit(p.sources, p.clips, p.subtitles,p.tracks);
        validateVoiceovers(p.sources, p.clips, p.voiceovers || [],p.tracks);
        if (!p.clips.length && !(p.voiceovers||[]).some(v=>v.detached)) throw new APIError("Add a clip before exporting");
        try { exportProfile(p.sources.find(s=>s.id===(p.clips[0]?.source_id||p.voiceovers[0]?.source_id)),options,projectDuration(p)); }
        catch (e) { throw new APIError(e.message,422); }
      } else throw new APIError("Unknown job type");
      const jid = uuid();
      await fs.mkdir(this.jobDir(jid));
      const j = {
        id: jid,
        project_id: id,
        kind,
        source_id: source_id ?? null,
        status: "queued",
        progress: 0,
        message: "等待处理",
        created_at: now(),
        project_revision: p.revision,
        ...(kind === "transcribe" ? { language } : {}),
        ...(kind === "export" ? { export_options: options, burn_subtitles } : {}),
      };
      await this.write(this.jobDir(jid, "job.json"), j);
      await this.write(this.jobDir(jid, "project-snapshot.json"), p);
      this.queue = this.queue
        .then(() =>
          this.work(jid, structuredClone(p), source_id, burn_subtitles),
        )
        .catch((e) => console.error("cutccc worker:", e.message));
      return j;
    });
  }
  async runProcess(jid, command, args, folder, duration = 0) {
    if (this.closed) throw new Error("Task interrupted by shutdown");
    const env = { ...process.env, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" };
    const child = launch(command, args, { cwd: folder, env });
    this.processes.add(child);
    const log = createWriteStream(path.join(folder, "process.log"));
    let updates = Promise.resolve(),
      chunks = 1,
      logError;
    log.on("error", (e) => {
      logError = e;
      void stopProcess(child);
    });
    const queueUpdate = (changes) => {
      updates = updates.then(() => this.updateJob(jid, changes));
    };
    child.stdout.on("data", (b) => log.write(b));
    child.stderr.on("data", (b) => log.write(b));
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (duration && line.startsWith("out_time_us=")) {
        const time = Number(line.slice(12));
        if (Number.isFinite(time))
          queueUpdate({
            progress: Math.min(99, Math.round((time / 1e6 / duration) * 100)),
            message: "正在导出视频",
          });
      } else if (line.startsWith("{"))
        try {
          const e = JSON.parse(line);
          if (e.stage === "detecting_speech")
            queueUpdate({ progress: 3, message: "正在检测人声并检查遗漏" });
          if (e.stage === "loading_asr") {
            chunks = e.chunks || 1;
            queueUpdate({ progress: 5, message: "正在加载字幕模型" });
          }
          if (e.stage === "transcribed")
            queueUpdate({
              progress: 10 + Math.round(((e.index + 1) / chunks) * 60),
              message: "正在识别语音",
            });
          if (e.stage === "loading_aligner")
            queueUpdate({ progress: 75, message: "正在加载时间轴模型" });
          if (e.stage === "aligned")
            queueUpdate({
              progress: 80 + Math.round(((e.index + 1) / chunks) * 18),
              message: "正在对齐字幕",
            });
        } catch {
          /* Ordinary worker output remains in the log. */
        }
    });
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      await updates;
      if (logError) throw logError;
      if (code !== 0)
        throw new Error(
          "Processing failed; see the task log for FFmpeg or model diagnostics",
        );
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null)
        await stopProcess(child);
      if (!log.destroyed) await new Promise((resolve) => log.end(resolve));
      this.processes.delete(child);
    }
  }
  async work(jid, p, sourceId, burn) {
    try {
      if (this.closed) throw new Error("Task interrupted by shutdown");
      const j = await this.updateJob(jid, {
          status: "running",
          started_at: now(),
          message: "开始处理",
        }),
        folder = this.jobDir(jid);
      let result;
      if (j.kind === "export") {
        result = await render(
          p,
          folder,
          (sid) => this.sourcePath(p.id, sid),
          (cmd, args, cwd, d) => this.runProcess(jid, cmd, args, cwd, d),
          burn,
          j.export_options,
        );
        result.video_url = `/api/jobs/${jid}/video`;
        result.subtitles_url = `/api/jobs/${jid}/subtitles`;
        result.styled_subtitles_url = `/api/jobs/${jid}/styled-subtitles`;
      } else {
        const original = p.sources.find((s) => s.id === sourceId);
        await this.runProcess(
          jid,
          this.python,
          [
            "-u",
            "-m",
            "cutccc",
            "transcribe",
            await this.sourcePath(p.id, sourceId),
            "--models-dir",
            this.models,
            "--output",
            path.join(folder, "transcription"),
            "--language",
            j.language || "auto",
          ],
          folder,
        );
        const generated = await this.read(
          path.join(folder, "transcription", "result.json"),
        );
        await this.exclusive(async () => {
          const current = await this.getProject(p.id),
            source = current.sources.find((s) => s.id === sourceId);
          if (source.subtitle_version !== original.subtitle_version)
            throw new APIError(
              "Subtitles were edited during transcription; generated results retained in task files",
              409,
            );
          let track;
          if(current.tracks!==undefined){track=getTracks(current).find(t=>t.type==='subtitle');if(!track){let number=1;while(current.tracks.some(t=>t.name==='字幕'+number))number++;track={id:'subtitle-main',type:'subtitle',name:'字幕'+number};}if(!current.tracks.some(t=>t.id===track.id))current.tracks.push(track);}
          const subtitles = {
            ...current.subtitles,
            [sourceId]: [...generated.cues.map(c=>({...c,...(track?{track_id:track.id}:{})})), ...(current.subtitles[sourceId] || []).filter(c => c.timeline_offset !== undefined)]
              .sort((a,b) => a.start - b.start || Number(a.timeline_offset !== undefined) - Number(b.timeline_offset !== undefined)),
          };
          validateEdit(current.sources, current.clips, subtitles,current.tracks);
          current.subtitles = subtitles;
          source.subtitle_version++;
          await this.save(current);
        });
        result = {
          subtitle_count: generated.cues.length,
          duration: generated.duration_seconds,
          language: generated.language || j.language || "auto",
          review_count: generated.review_count || 0,
        };
        for (const [name, key, route] of [
          ["review.txt", "review_url", "review"],
          ["subtitles.srt", "subtitles_url", "subtitles"],
          ["transcript.txt", "transcript_url", "transcript"],
        ]) {
          if (await exists(path.join(folder, "transcription", name)))
            result[key] = `/api/jobs/${jid}/${route}`;
        }
      }
      await this.updateJob(jid, {
        status: "completed",
        progress: 100,
        message: j.kind === "transcribe" && result.review_count ? `识别完成，${result.review_count}处需复核` : "处理完成",
        result,
        finished_at: now(),
      });
    } catch (e) {
      await this.updateJob(jid, {
        status: "failed",
        message: e.message.slice(0, 600),
        finished_at: now(),
      });
    }
  }
  async jobFile(id, name) {
    const j = await this.getJob(id);
    if (
      ![
        "video.mp4",
        "subtitles.srt",
        "subtitles.ass",
        "process.log",
        "review.txt",
        "transcript.txt",
      ].includes(name)
    )
      throw new APIError("Unknown output file");
    if (
      name !== "process.log" &&
      (j.status !== "completed" || !["export", "transcribe"].includes(j.kind))
    )
      throw new APIError("Task is not complete");
    if (["video.mp4", "subtitles.ass"].includes(name) && j.kind !== "export")
      throw new APIError("This task has no video output");
    if (
      ["review.txt", "transcript.txt"].includes(name) &&
      j.kind !== "transcribe"
    )
      throw new APIError("This task has no recognition report");
    const file =
      j.kind === "transcribe" && name !== "process.log"
        ? this.jobDir(id, "transcription", name)
        : this.jobDir(id, name);
    if (!(await exists(file))) throw new APIError("Output file not found", 404);
    return file;
  }
  async openFolder(folder) { await openFolder(folder); }
  async openExportFolder(id) {
    const video = await this.jobFile(id, "video.mp4");
    await this.openFolder(path.dirname(video));
    return {opened:true};
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.processes].map(stopProcess));
    await this.queue;
    await this.waveformQueue;
    for (const j of await this.allJobs())
      if (["queued", "running"].includes(j.status))
        await this.updateJob(j.id, {
          status: "failed",
          message: "Task interrupted by shutdown",
          finished_at: now(),
        });
    await this.releaseLock();
  }
}
