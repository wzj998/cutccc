"""Loopback HTTP API and locally bundled editor UI."""

from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .models import default_models_dir, validate_models
from .studio import ConflictError, Studio, default_data_dir


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NewProject(StrictBody):
    title: str = Field(default="未命名项目", min_length=1, max_length=120)


class ImportPath(StrictBody):
    path: str = Field(min_length=1)


class Clip(StrictBody):
    source_id: str
    start: float
    end: float


class Subtitle(StrictBody):
    start: float
    end: float
    text: str


class Edit(StrictBody):
    revision: int = Field(ge=1, strict=True)
    clips: list[Clip]
    subtitles: dict[str, list[Subtitle]]
    title: str | None = None


class Transcription(StrictBody):
    source_id: str


class Export(StrictBody):
    burn_subtitles: bool = True


def create_app(data_dir=None, models_dir=None, inference_python=None):
    studio = Studio(data_dir or default_data_dir(), models_dir or default_models_dir(), inference_python)

    @asynccontextmanager
    async def lifespan(app):
        yield
        studio.close()

    app = FastAPI(title="cutccc local API", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.studio = studio
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])

    @app.middleware("http")
    async def local_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and (urlsplit(origin).scheme not in ("http", "https") or urlsplit(origin).netloc != request.headers.get("host")):
            return JSONResponse({"detail": "Cross-origin requests are not allowed"}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'"
        return response

    @app.exception_handler(ConflictError)
    async def conflict(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(ValueError)
    async def invalid(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(FileNotFoundError)
    async def missing(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @app.exception_handler(RuntimeError)
    async def unavailable(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=503)

    @app.get("/api/health")
    def health():
        try:
            validate_models(studio.models)
            ready = True
        except (OSError, ValueError, KeyError):
            ready = False
        return dict(status="ok", version=__version__, models_ready=ready)

    @app.get("/api/projects")
    def projects():
        return {"projects": studio.list_projects()}

    @app.post("/api/projects", status_code=201)
    def create_project(body: NewProject):
        return studio.create_project(body.title)

    @app.get("/api/projects/{project_id}")
    def project(project_id: str):
        return studio.get_project(project_id)

    @app.patch("/api/projects/{project_id}")
    def edit(project_id: str, body: Edit):
        return studio.update_edit(project_id, body.revision, [c.model_dump() for c in body.clips],
                                  {k: [c.model_dump() for c in v] for k, v in body.subtitles.items()}, body.title)

    @app.post("/api/projects/{project_id}/sources/upload", status_code=201)
    def upload(project_id: str, file: UploadFile = File(...)):
        return studio.import_source(project_id, file.file, file.filename or "video.mp4")

    @app.post("/api/projects/{project_id}/sources/import", status_code=201)
    def import_source(project_id: str, body: ImportPath):
        return studio.import_path(project_id, body.path)

    @app.get("/api/projects/{project_id}/sources/{source_id}/media")
    def media(project_id: str, source_id: str):
        return FileResponse(studio.source_path(project_id, source_id))

    @app.get("/api/projects/{project_id}/sources/{source_id}/poster")
    def poster(project_id: str, source_id: str):
        return FileResponse(studio.source_path(project_id, source_id, poster=True), media_type="image/jpeg")

    @app.post("/api/projects/{project_id}/transcribe", status_code=202)
    def transcribe(project_id: str, body: Transcription):
        return studio.submit(project_id, "transcribe", source_id=body.source_id)

    @app.post("/api/projects/{project_id}/export", status_code=202)
    def export(project_id: str, body: Export):
        return studio.submit(project_id, "export", burn_subtitles=body.burn_subtitles)

    @app.get("/api/projects/{project_id}/jobs")
    def project_jobs(project_id: str):
        return {"jobs": studio.list_jobs(project_id)}

    @app.get("/api/jobs/{job_id}")
    def job(job_id: str):
        return studio.get_job(job_id)

    @app.get("/api/jobs/{job_id}/video")
    def video(job_id: str):
        return FileResponse(studio.job_file(job_id, "video.mp4"), media_type="video/mp4", filename="cutccc-export.mp4")

    @app.get("/api/jobs/{job_id}/subtitles")
    def subtitles(job_id: str):
        return FileResponse(studio.job_file(job_id, "subtitles.srt"), media_type="text/plain; charset=utf-8", filename="subtitles.srt")

    @app.get("/api/jobs/{job_id}/log")
    def log(job_id: str):
        return FileResponse(studio.job_file(job_id, "process.log"), media_type="text/plain; charset=utf-8")

    web = Path(__file__).parent / "web"
    app.mount("/static", StaticFiles(directory=web), name="static")

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(web / "index.html")

    @app.get("/api-docs", include_in_schema=False)
    def api_docs():
        return FileResponse(web / "api.html")

    return app
