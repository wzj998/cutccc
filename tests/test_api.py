import io
import json
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from cutccc.api import create_app
from cutccc.studio import Studio


class APITests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.app = create_app(self.root / "data", self.root / "models")
        self.client = TestClient(self.app, base_url="http://127.0.0.1")
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def project_with_source(self):
        project = self.client.post("/api/projects", json={"title": "Example"}).json()
        metadata = dict(duration=10, width=320, height=180, has_audio=True)
        def poster(src, target):
            target.write_bytes(b"test-thumbnail")
        with patch("cutccc.studio.probe", return_value=metadata), patch("cutccc.studio.thumbnail", side_effect=poster):
            response = self.client.post(f"/api/projects/{project['id']}/sources/upload", files={"file": ("example.mp4", b"test-video", "video/mp4")})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_ui_schema_and_health(self):
        self.assertIn("本地剪辑工作台", self.client.get("/").text)
        self.assertIn("/api/projects", self.client.get("/openapi.json").json()["paths"])
        self.assertFalse(self.client.get("/api/health").json()["models_ready"])

    def test_edit_persists_and_stale_revision_does_not_overwrite(self):
        p = self.project_with_source()
        sid = p["sources"][0]["id"]
        body = dict(revision=p["revision"], clips=[dict(source_id=sid, start=1, end=3)],
                    subtitles={sid: [dict(start=1, end=2, text="字幕")]})
        result = self.client.patch(f"/api/projects/{p['id']}", json=body)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["sources"][0]["subtitle_version"], 1)
        stale = self.client.patch(f"/api/projects/{p['id']}", json=body)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(self.client.get(f"/api/projects/{p['id']}").json()["clips"][0]["start"], 1)
        self.assertTrue((self.root / "data/projects" / p["id"] / "project.json").is_file())

    def test_invalid_edit_does_not_change_revision(self):
        p = self.project_with_source()
        invalid = dict(revision=p["revision"], clips=[dict(source_id=p["sources"][0]["id"], start=3, end=2)], subtitles={})
        self.assertEqual(self.client.patch(f"/api/projects/{p['id']}", json=invalid).status_code, 400)
        self.assertEqual(self.client.get(f"/api/projects/{p['id']}").json()["revision"], p["revision"])

    def test_origin_and_host_protection(self):
        self.assertEqual(self.client.post("/api/projects", json={}, headers={"Origin": "https://unrelated.invalid"}).status_code, 403)
        self.assertEqual(self.client.get("/api/health", headers={"Host": "unrelated.invalid"}).status_code, 400)
        self.assertEqual(self.client.post("/api/projects", json={}, headers={"Origin": "http://127.0.0.1"}).status_code, 201)

    def test_unknown_identifiers_and_unfinished_outputs(self):
        self.assertEqual(self.client.get("/api/projects/not-an-id").status_code, 400)
        self.assertEqual(self.client.get("/api/jobs/" + "a" * 32).status_code, 404)

    def test_media_range_requests(self):
        p = self.project_with_source()
        sid = p["sources"][0]["id"]
        response = self.client.get(f"/api/projects/{p['id']}/sources/{sid}/media", headers={"Range": "bytes=0-3"})
        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.content, b"test")

    def test_failure_is_visible_in_job_state(self):
        p = self.project_with_source()
        with patch("cutccc.studio.render", side_effect=RuntimeError("test encoder failure")):
            response = self.client.post(f"/api/projects/{p['id']}/export", json={})
            self.assertEqual(response.status_code, 202)
            job_id = response.json()["id"]
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "failed")
        self.assertIn("test encoder failure", job["message"])
        self.assertEqual(self.client.get(f"/api/jobs/{job_id}/video").status_code, 400)

    def test_server_directory_lock(self):
        with self.assertRaisesRegex(RuntimeError, "already used"):
            Studio(self.root / "data", self.root / "models")

    def test_transcription_does_not_overwrite_concurrent_subtitle_edits(self):
        p = self.project_with_source()
        sid = p["sources"][0]["id"]
        started, release = threading.Event(), threading.Event()
        def fake_inference(job_id, command, folder, duration=0):
            started.set()
            if not release.wait(5):
                raise RuntimeError("Test synchronization timed out")
            (folder / "transcription").mkdir()
            (folder / "transcription/result.json").write_text(json.dumps({"duration_seconds": 10,
                "cues": [{"start": 0, "end": 1, "text": "generated"}]}), encoding="utf-8")
        with patch("cutccc.studio.validate_models"), patch.object(self.app.state.studio, "_run_process", side_effect=fake_inference):
            response = self.client.post(f"/api/projects/{p['id']}/transcribe", json={"source_id": sid})
            self.assertEqual(response.status_code, 202)
            job_id = response.json()["id"]
            self.assertTrue(started.wait(5))
            try:
                duplicate = self.client.post(f"/api/projects/{p['id']}/transcribe", json={"source_id": sid})
                self.assertEqual(duplicate.status_code, 409)
                edit = dict(revision=p["revision"], clips=p["clips"], subtitles={sid: [dict(start=0, end=1, text="manual")]})
                self.assertEqual(self.client.patch(f"/api/projects/{p['id']}", json=edit).status_code, 200)
            finally:
                release.set()
            job = self.wait_job(job_id)
        self.assertEqual(job["status"], "failed")
        self.assertIn("edited during transcription", job["message"])
        self.assertEqual(self.client.get(f"/api/projects/{p['id']}").json()["subtitles"][sid][0]["text"], "manual")

    def test_export_uses_submission_snapshot(self):
        p = self.project_with_source()
        started, release = threading.Event(), threading.Event()
        seen = []
        def fake_render(snapshot, *args):
            started.set()
            if not release.wait(5):
                raise RuntimeError("Test synchronization timed out")
            seen.append(snapshot["clips"][0]["end"])
            return {"duration": 10}
        with patch("cutccc.studio.render", side_effect=fake_render):
            job_id = self.client.post(f"/api/projects/{p['id']}/export", json={}).json()["id"]
            self.assertTrue(started.wait(5))
            try:
                edit = dict(revision=p["revision"], clips=[dict(source_id=p["sources"][0]["id"], start=0, end=2)], subtitles={})
                self.assertEqual(self.client.patch(f"/api/projects/{p['id']}", json=edit).status_code, 200)
            finally:
                release.set()
            self.assertEqual(self.wait_job(job_id)["status"], "completed")
        self.assertEqual(seen, [10])

    def wait_job(self, job_id):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            job = self.client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in ("completed", "failed"):
                return job
            time.sleep(0.05)
        self.fail("Job did not finish")


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg integration requires ffmpeg and ffprobe")
class ExportTests(unittest.TestCase):
    setUp = APITests.setUp
    tearDown = APITests.tearDown
    wait_job = APITests.wait_job

    def test_real_export_reorders_sources_with_and_without_audio(self):
        p = self.client.post("/api/projects", json={"title": "Synthetic export"}).json()
        for color, audio in [("red", True), ("blue", False)]:
            path = self.root / f"{color}.mp4"
            command = ["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", f"color={color}:s=160x90:r=30:d=2"]
            if audio:
                command += ["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac"]
            command += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "2", str(path)]
            subprocess.run(command, check=True, capture_output=True)
            response = self.client.post(f"/api/projects/{p['id']}/sources/import", json={"path": str(path)})
            self.assertEqual(response.status_code, 201, response.text)
            p = response.json()
        a, b = (s["id"] for s in p["sources"])
        edit = dict(revision=p["revision"], clips=[dict(source_id=b, start=0.5, end=1.5), dict(source_id=a, start=0, end=1)],
                    subtitles={a: [dict(start=0.2, end=0.8, text="Sample")]})
        self.assertEqual(self.client.patch(f"/api/projects/{p['id']}", json=edit).status_code, 200)
        submitted = self.client.post(f"/api/projects/{p['id']}/export", json={"burn_subtitles": True}).json()
        job = self.wait_job(submitted["id"])
        self.assertEqual(job["status"], "completed", job)
        self.assertAlmostEqual(job["result"]["duration"], 2, delta=0.1)
        srt = self.client.get(job["result"]["subtitles_url"]).text
        self.assertIn("00:00:01,200 --> 00:00:01,800", srt)
        path = self.root / "export.mp4"
        path.write_bytes(self.client.get(job["result"]["video_url"]).content)
        for at, expected in [(0.2, 2), (1.2, 0)]:
            frame = subprocess.check_output(["ffmpeg", "-v", "error", "-ss", str(at), "-i", str(path), "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"])
            self.assertEqual(max(range(3), key=lambda i: frame[i]), expected)
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"], check=True, capture_output=True)


class RecoveryTests(unittest.TestCase):
    def test_restart_marks_interrupted_jobs_failed_and_keeps_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            studio = Studio(root / "data", root / "models")
            project = studio.create_project("Persistent project")
            studio.close()
            job_id = "b" * 32
            folder = root / "data/jobs" / job_id
            folder.mkdir()
            (folder / "job.json").write_text(json.dumps(dict(id=job_id, project_id=project["id"], status="running")), encoding="utf-8")
            reopened = Studio(root / "data", root / "models")
            try:
                self.assertEqual(reopened.get_project(project["id"])["title"], "Persistent project")
                self.assertEqual(reopened.get_job(job_id)["status"], "failed")
            finally:
                reopened.close()


if __name__ == "__main__":
    unittest.main()
