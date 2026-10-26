import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cutccc.cli import main
from cutccc.models import MODEL_NAMES, default_models_dir, validate_models
from cutccc.pipeline import reserve_output


class FileTests(unittest.TestCase):
    def test_existing_output_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "video.mp4"
            out = reserve_output(source, None)
            sentinel = out / "sentinel.txt"
            sentinel.write_text("keep", encoding="utf-8")
            with self.assertRaises(ValueError):
                reserve_output(source, out)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_models_dir_override(self):
        with patch.dict("os.environ", {"CUTCCC_MODELS_DIR": "models"}):
            self.assertEqual(default_models_dir(), Path("models"))

    def test_missing_weight_shard_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in MODEL_NAMES:
                folder = root / name
                folder.mkdir()
                for filename in ["config.json", "preprocessor_config.json", "tokenizer_config.json", "vocab.json", "merges.txt", "model.safetensors"]:
                    (folder / filename).write_text("{}", encoding="utf-8")
            validate_models(root)
            folder = root / MODEL_NAMES[0]
            (folder / "model.safetensors.index.json").write_text(
                json.dumps({"weight_map": {"layer": "missing.safetensors"}}), encoding="utf-8")
            with self.assertRaises(FileNotFoundError):
                validate_models(root)

    def test_checkpoint_path_escape_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            folder = root / MODEL_NAMES[0]
            folder.mkdir()
            (folder / "model.safetensors.index.json").write_text(
                json.dumps({"weight_map": {"layer": "../outside.safetensors"}}), encoding="utf-8")
            for filename in ["config.json", "preprocessor_config.json", "tokenizer_config.json", "vocab.json", "merges.txt"]:
                (folder / filename).write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Invalid checkpoint"):
                validate_models(root)

    def test_cli_dispatches_without_loading_gpu(self):
        with patch("cutccc.pipeline.transcribe_file") as run:
            self.assertEqual(main(["transcribe", "video.mp4", "--models-dir", "models"]), 0)
            run.assert_called_once_with(Path("video.mp4"), None, Path("models"))

    def test_cli_reports_failure(self):
        with patch("cutccc.pipeline.transcribe_file", side_effect=ValueError("bad input")), contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(main(["transcribe", "video.mp4"]), 1)
            self.assertIn("bad input", stderr.getvalue())

    def test_download_dispatch(self):
        with patch("cutccc.cli.download_models") as download:
            self.assertEqual(main(["download", "--models-dir", "models"]), 0)
            download.assert_called_once_with(Path("models").resolve())

    def test_python_serve_entry_forwards_to_node_without_importing_web_runtime(self):
        with patch("cutccc.cli.shutil.which", return_value="node"), patch("cutccc.cli.subprocess.call", return_value=0) as call:
            self.assertEqual(main(["serve", "--port", "18766", "--data-dir", "external project"]), 0)
            command = call.call_args.args[0]
            self.assertEqual(command[0], "node")
            self.assertTrue(command[1].endswith("cli.js"))
            self.assertEqual(command[-2:], ["--data-dir", "external project"])


if __name__ == "__main__":
    unittest.main()
