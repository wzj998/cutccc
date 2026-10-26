"""Command-line interface with no GPU imports until transcription starts."""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

from . import __version__
from .models import default_models_dir, download_models
from .recognition import LANGUAGES


def main(argv=None):
    parser = argparse.ArgumentParser(description="cutccc: local Chinese/English speech to original-language subtitles")
    parser.add_argument("--version", action="version", version=f"cutccc {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("download", help="Download official Qwen models (~6.5 GB)")
    download.add_argument("--models-dir", type=Path, default=default_models_dir())
    transcribe = commands.add_parser("transcribe", help="Generate original-language subtitles and a recognition review report")
    transcribe.add_argument("input", type=Path, help="Local video or audio file")
    transcribe.add_argument("-o", "--output", type=Path, help="New output directory; never overwrite existing directories")
    transcribe.add_argument("--models-dir", type=Path, default=default_models_dir())
    transcribe.add_argument("--language", choices=LANGUAGES, default="auto", help="auto preserves Chinese and English as spoken")
    serve = commands.add_parser("serve", help="Start the local web editor and HTTP API")
    serve.add_argument("--port", type=int, default=18765)
    serve.add_argument("--data-dir", type=Path)
    serve.add_argument("--models-dir", type=Path, default=default_models_dir())
    serve.add_argument("--inference-python", help="Optional Python environment with cutccc[inference] installed")
    mcp = commands.add_parser("mcp", help="Run the stdio MCP bridge to a local cutccc server")
    mcp.add_argument("--api-url", default="http://127.0.0.1:18765")
    args = parser.parse_args(argv)
    try:
        if args.command == "download":
            download_models(args.models_dir.expanduser().resolve())
        elif args.command == "transcribe":
            from .pipeline import transcribe_file
            transcribe_file(args.input, args.output, args.models_dir, language=args.language)
        elif args.command == "serve":
            if not 1 <= args.port <= 65535:
                raise ValueError("Port must be between 1 and 65535")
            command = node_command("serve", "--port", str(args.port), "--models-dir", str(args.models_dir),
                                   "--inference-python", args.inference_python or sys.executable)
            if args.data_dir is not None:
                command.extend(["--data-dir", str(args.data_dir)])
            return subprocess.call(command)
        elif args.command == "mcp":
            return subprocess.call(node_command("mcp", "--api-url", args.api_url))
        return 0
    except ImportError as exc:
        print(f"cutccc: optional dependency missing ({exc.name}); install cutccc[inference] as needed", file=sys.stderr)
        return 1
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"cutccc: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("cutccc: interrupted; partial outputs are retained", file=sys.stderr)
        return 130


def node_command(*args):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js 22 or newer is required for serve and mcp")
    return [node, str(Path(__file__).parent / "node" / "cli.js"), *args]
