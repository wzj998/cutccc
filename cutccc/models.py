"""Explicit model downloads, separate from offline inference."""

import json
import os
from pathlib import Path

MODEL_NAMES = ("Qwen3-ASR-1.7B", "Qwen3-ForcedAligner-0.6B")


def default_models_dir():
    configured = os.environ.get("CUTCCC_MODELS_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".cache" / "cutccc" / "models"


def validate_models(root):
    for name in MODEL_NAMES:
        folder = root / name
        required = ["config.json", "preprocessor_config.json", "tokenizer_config.json", "vocab.json", "merges.txt"]
        index = folder / "model.safetensors.index.json"
        if index.is_file():
            data = json.loads(index.read_text(encoding="utf-8"))
            weights = set(data["weight_map"].values())
            if not weights:
                raise ValueError(f"Empty weight index: {name}")
        else:
            weights = {"model.safetensors"}
        for filename in [*required, *weights]:
            path = folder / filename
            if path.parent.resolve() != folder.resolve():
                raise ValueError(f"Invalid checkpoint filename in {name}")
            if not path.is_file() or path.stat().st_size == 0:
                raise FileNotFoundError(f"Missing model file: {path}. Run 'cutccc download' first.")


def download_models(root):
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise RuntimeError("Install inference dependencies: python -m pip install -e '.[inference]'") from exc
    for name in MODEL_NAMES:
        print(f"Downloading Qwen/{name}", flush=True)
        snapshot_download(
            repo_id=f"Qwen/{name}", local_dir=str(root / name),
            allow_patterns=["*.json", "*.safetensors", "*.txt", "*.tiktoken"], max_workers=2,
        )
    validate_models(root)
    print(f"Models ready: {root}", flush=True)
