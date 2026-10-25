"""Persistent local projects and a single background worker shared by UI/API/MCP."""

import copy
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .editing import output_duration, validate_edit
from .media import probe, render, thumbnail
from .models import validate_models
from .processes import stop_process


class ConflictError(ValueError):
    pass


def default_data_dir():
    return Path(os.environ.get("CUTCCC_DATA_DIR", str(Path.home() / ".local" / "share" / "cutccc"))).expanduser()


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
        raise ValueError("Invalid identifier")
    return value


class Studio:
    def __init__(self, data_dir, models_dir, inference_python=None):
        from filelock import FileLock, Timeout
        self.root = Path(data_dir).expanduser().resolve()
        self.models = Path(models_dir).expanduser().resolve()
        self.python = inference_python or os.environ.get("CUTCCC_INFERENCE_PYTHON") or sys.executable
        self.root.mkdir(parents=True, exist_ok=True)
        self.directory_lock = FileLock(str(self.root / ".studio.lock"), thread_local=False)
        try:
            self.directory_lock.acquire(timeout=0)
        except Timeout as exc:
            raise RuntimeError("This data directory is already used by another cutccc server") from exc
        (self.root / "projects").mkdir(exist_ok=True)
        (self.root / "jobs").mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cutccc")
        self.processes = {}
        self.closed = False
        for path in (self.root / "jobs").glob("*/job.json"):
            job = self.read(path)
            if job["status"] in ("queued", "running"):
                job.update(status="failed", message="Server restarted; previous task was interrupted", finished_at=time.time())
                self.write(path, job)

    @staticmethod
    def read(path):
        if not path.is_file():
            raise FileNotFoundError("Project, source or job not found")
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def write(path, data):
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)

    def project_dir(self, project_id):
        return self.root / "projects" / identifier(project_id)

    def get_project(self, project_id):
        with self.lock:
            return self.read(self.project_dir(project_id) / "project.json")

    def list_projects(self):
        with self.lock:
            projects = [self.read(p) for p in (self.root / "projects").glob("*/project.json")]
        return sorted([dict(id=p["id"], title=p["title"], updated_at=p["updated_at"], revision=p["revision"],
                            source_count=len(p["sources"]), duration=output_duration(p["clips"])) for p in projects],
                      key=lambda p: p["updated_at"], reverse=True)

    def create_project(self, title="未命名项目"):
        title = title.strip()
        if not title or len(title) > 120:
            raise ValueError("Project title must contain 1–120 characters")
        with self.lock:
            project_id = uuid.uuid4().hex
            folder = self.project_dir(project_id)
            (folder / "media").mkdir(parents=True)
            project = dict(id=project_id, title=title, revision=1, updated_at=time.time(),
                           sources=[], clips=[], subtitles={})
            self.write(folder / "project.json", project)
            return project

    def _save_project(self, project):
        project["revision"] += 1
        project["updated_at"] = time.time()
        self.write(self.project_dir(project["id"]) / "project.json", project)
        return project

    def import_source(self, project_id, stream, name):
        self.get_project(project_id)
        source_id = uuid.uuid4().hex
        name = Path(name.replace("\\", "/")).name[:160] or "video.mp4"
        suffix = Path(name).suffix.lower()
        if suffix not in (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mts"):
            suffix = ".mp4"
        folder = self.project_dir(project_id) / "media"
        target = folder / (source_id + suffix)
        thumb = folder / (source_id + ".jpg")
        try:
            with target.open("xb") as output:
                shutil.copyfileobj(stream, output, length=1024 * 1024)
            metadata = probe(target)
            thumbnail(target, thumb)
            with self.lock:
                project = self.get_project(project_id)
                source = dict(id=source_id, name=name, file=target.name, subtitle_version=0, **metadata)
                project["sources"].append(source)
                project["subtitles"][source_id] = []
                project["clips"].append(dict(source_id=source_id, start=0.0, end=metadata["duration"]))
                validate_edit(project["sources"], project["clips"], project["subtitles"])
                return self._save_project(project)
        except Exception:
            target.unlink(missing_ok=True)
            thumb.unlink(missing_ok=True)
            raise

    def import_path(self, project_id, path):
        path = Path(path).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError("Input video does not exist")
        with path.open("rb") as stream:
            return self.import_source(project_id, stream, path.name)

    def source_path(self, project_id, source_id, poster=False):
        identifier(source_id)
        project = self.get_project(project_id)
        source = next((s for s in project["sources"] if s["id"] == source_id), None)
        if source is None:
            raise FileNotFoundError("Source not found")
        folder = self.project_dir(project_id) / "media"
        path = (folder / (source_id + ".jpg" if poster else source["file"])).resolve()
        if path.parent != folder.resolve() or not path.is_file():
            raise FileNotFoundError("Source file not found")
        return path

    def update_edit(self, project_id, revision, clips, subtitles, title=None):
        with self.lock:
            project = self.get_project(project_id)
            if project["revision"] != revision:
                raise ConflictError("Project changed in another client. Reload before saving.")
            validate_edit(project["sources"], clips, subtitles)
            if title is not None:
                if not title.strip() or len(title) > 120:
                    raise ValueError("Project title must contain 1–120 characters")
                project["title"] = title.strip()
            for source in project["sources"]:
                if project["subtitles"].get(source["id"], []) != subtitles.get(source["id"], []):
                    source["subtitle_version"] += 1
            project["clips"] = copy.deepcopy(clips)
            project["subtitles"] = {s["id"]: copy.deepcopy(subtitles.get(s["id"], [])) for s in project["sources"]}
            return self._save_project(project)

    def get_job(self, job_id):
        with self.lock:
            return self.read(self.root / "jobs" / identifier(job_id) / "job.json")

    def list_jobs(self, project_id):
        self.get_project(project_id)
        with self.lock:
            jobs = [self.read(p) for p in (self.root / "jobs").glob("*/job.json")]
            return sorted([j for j in jobs if j["project_id"] == project_id], key=lambda j: j["created_at"], reverse=True)

    def _update_job(self, job_id, **changes):
        with self.lock:
            job = self.get_job(job_id)
            job.update(changes)
            self.write(self.root / "jobs" / job_id / "job.json", job)
            return job

    def submit(self, project_id, kind, source_id=None, burn_subtitles=True):
        with self.lock:
            if self.closed:
                raise RuntimeError("Server is shutting down")
            project = self.get_project(project_id)
            if kind == "transcribe":
                self.source_path(project_id, source_id)
                validate_models(self.models)
                if any(j["kind"] == "transcribe" and j["source_id"] == source_id and j["status"] in ("queued", "running")
                       for j in self.list_jobs(project_id)):
                    raise ConflictError("A transcription task is already active for this source")
            elif kind == "export":
                validate_edit(project["sources"], project["clips"], project["subtitles"])
                if not project["clips"]:
                    raise ValueError("Add a clip before exporting")
            else:
                raise ValueError("Unknown job type")
            job_id = uuid.uuid4().hex
            folder = self.root / "jobs" / job_id
            folder.mkdir()
            job = dict(id=job_id, project_id=project_id, kind=kind, source_id=source_id, status="queued", progress=0,
                       message="等待处理", created_at=time.time(), project_revision=project["revision"])
            self.write(folder / "job.json", job)
            self.write(folder / "project-snapshot.json", project)
            self.pool.submit(self._work, job_id, project, source_id, burn_subtitles)
            return job

    def _run_process(self, job_id, command, folder, duration=0):
        environment = dict(os.environ, PYTHONUTF8="1", PYTHONUNBUFFERED="1")
        with self.lock:
            if self.closed:
                raise RuntimeError("Task interrupted by shutdown")
            process = subprocess.Popen(command, cwd=folder, env=environment, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            self.processes[job_id] = process
        chunks = 1
        try:
            with (folder / "process.log").open("w", encoding="utf-8") as log:
                for line in process.stdout:
                    log.write(line)
                    log.flush()
                    if duration and line.startswith("out_time_us="):
                        try:
                            self._update_job(job_id, progress=min(99, round(float(line.split("=", 1)[1]) / 1e6 / duration * 100)), message="正在导出视频")
                        except ValueError:
                            pass
                    elif line.startswith("{"):
                        try:
                            event = json.loads(line)
                            stage = event.get("stage")
                            if stage == "loading_asr":
                                chunks = event.get("chunks", 1)
                                self._update_job(job_id, progress=5, message="正在加载字幕模型")
                            elif stage == "transcribed":
                                self._update_job(job_id, progress=10 + round((event["index"] + 1) / chunks * 60), message="正在识别语音")
                            elif stage == "loading_aligner":
                                self._update_job(job_id, progress=75, message="正在加载时间轴模型")
                            elif stage == "aligned":
                                self._update_job(job_id, progress=80 + round((event["index"] + 1) / chunks * 18), message="正在对齐字幕")
                        except (ValueError, KeyError):
                            pass
            if process.wait() != 0:
                raise RuntimeError("Processing failed; see the task log for FFmpeg or model diagnostics")
        finally:
            process.stdout.close()
            if process.poll() is None:
                stop_process(process)
            with self.lock:
                self.processes.pop(job_id, None)

    def _work(self, job_id, project, source_id, burn_subtitles):
        folder = self.root / "jobs" / job_id
        job = self._update_job(job_id, status="running", started_at=time.time(), message="开始处理")
        try:
            if job["kind"] == "export":
                result = render(project, folder, lambda sid: self.source_path(project["id"], sid),
                                lambda cmd, cwd, duration: self._run_process(job_id, cmd, cwd, duration), burn_subtitles)
                result.update(video_url=f"/api/jobs/{job_id}/video", subtitles_url=f"/api/jobs/{job_id}/subtitles")
            else:
                original_source = next(s for s in project["sources"] if s["id"] == source_id)
                self._run_process(job_id, [self.python, "-u", "-m", "cutccc", "transcribe",
                    str(self.source_path(project["id"], source_id)), "--models-dir", str(self.models),
                    "--output", str(folder / "transcription")], folder)
                result = self.read(folder / "transcription" / "result.json")
                with self.lock:
                    current = self.get_project(project["id"])
                    source = next(s for s in current["sources"] if s["id"] == source_id)
                    if source["subtitle_version"] != original_source["subtitle_version"]:
                        raise ConflictError("Subtitles were edited during transcription; generated results retained in task files")
                    updated = copy.deepcopy(current["subtitles"])
                    updated[source_id] = result["cues"]
                    validate_edit(current["sources"], current["clips"], updated)
                    current["subtitles"] = updated
                    source["subtitle_version"] += 1
                    self._save_project(current)
                result = dict(subtitle_count=len(result["cues"]), duration=result["duration_seconds"])
            self._update_job(job_id, status="completed", progress=100, message="处理完成", result=result, finished_at=time.time())
        except Exception as exc:
            self._update_job(job_id, status="failed", message=str(exc)[:600], finished_at=time.time())

    def job_file(self, job_id, name):
        job = self.get_job(job_id)
        if name != "process.log" and (job["status"] != "completed" or job["kind"] != "export"):
            raise ValueError("Export is not complete")
        if name not in ("video.mp4", "subtitles.srt", "process.log"):
            raise ValueError("Unknown output file")
        path = self.root / "jobs" / job_id / name
        if not path.is_file():
            raise FileNotFoundError("Output file not found")
        return path

    def close(self):
        with self.lock:
            self.closed = True
            for process in self.processes.values():
                if process.poll() is None:
                    stop_process(process)
        self.pool.shutdown(wait=True, cancel_futures=True)
        with self.lock:
            for path in (self.root / "jobs").glob("*/job.json"):
                job = self.read(path)
                if job["status"] in ("queued", "running"):
                    job.update(status="failed", message="Task interrupted by shutdown", finished_at=time.time())
                    self.write(path, job)
        self.directory_lock.release()
