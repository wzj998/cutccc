"""stdio MCP bridge: all operations use the same running local HTTP API."""

import json
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


def create_mcp(api_url="http://127.0.0.1:18765"):
    from mcp.server.fastmcp import FastMCP
    parsed = urlsplit(api_url)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost") or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("MCP requires a loopback cutccc HTTP URL")
    base = api_url.rstrip("/")
    server = FastMCP("cutccc")

    def call(method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(base + path, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urlopen(request, timeout=300) as response:
                return json.load(response)
        except HTTPError as exc:
            detail = json.loads(exc.read()).get("detail", str(exc))
            raise ValueError(f"cutccc API {exc.code}: {detail}") from exc
        except URLError as exc:
            raise RuntimeError("Cannot reach cutccc. Start 'cutccc serve' first.") from exc

    @server.tool()
    def service_status() -> dict:
        """Check the local editing service and whether subtitle model files are available."""
        return call("GET", "/api/health")

    @server.tool()
    def list_projects() -> dict:
        """List local editing projects."""
        return call("GET", "/api/projects")

    @server.tool()
    def create_project(title: str = "新项目") -> dict:
        """Create a local editing project."""
        return call("POST", "/api/projects", {"title": title})

    @server.tool()
    def import_video(project_id: str, path: str) -> dict:
        """Copy an explicitly selected local video into a project and append a full-length clip."""
        return call("POST", f"/api/projects/{project_id}/sources/import", {"path": path})

    @server.tool()
    def get_project(project_id: str) -> dict:
        """Get sources, clips, source-clock subtitles and the current revision before editing."""
        return call("GET", f"/api/projects/{project_id}")

    @server.tool()
    def update_edit(project_id: str, revision: int, clips: list[dict], subtitles: dict[str, list[dict]], title: str | None = None) -> dict:
        """Replace the edit using its current revision. Clips: source_id/start/end seconds; subtitles: source_id -> start/end/text cues. Rejects stale revisions."""
        body = dict(revision=revision, clips=clips, subtitles=subtitles)
        if title is not None:
            body["title"] = title
        return call("PATCH", f"/api/projects/{project_id}", body)

    @server.tool()
    def transcribe_source(project_id: str, source_id: str) -> dict:
        """Queue local subtitle recognition for one source. Poll get_job; generation updates source subtitles on success."""
        return call("POST", f"/api/projects/{project_id}/transcribe", {"source_id": source_id})

    @server.tool()
    def export_video(project_id: str, burn_subtitles: bool = True) -> dict:
        """Queue a snapshot export of the saved edit to MP4 plus retimed SRT. Poll get_job for download URLs."""
        return call("POST", f"/api/projects/{project_id}/export", {"burn_subtitles": burn_subtitles})

    @server.tool()
    def get_job(job_id: str) -> dict:
        """Get queued/running/completed/failed state, progress and relative output URLs."""
        result = call("GET", f"/api/jobs/{job_id}")
        for key in ("video_url", "subtitles_url"):
            if key in result.get("result", {}):
                result["result"][key] = base + result["result"][key]
        return result

    @server.resource("cutccc://status")
    def status_resource() -> str:
        """Local cutccc service status."""
        return json.dumps(call("GET", "/api/health"), ensure_ascii=False)

    return server
