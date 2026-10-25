"""Command-line interface with no GPU imports until transcription starts."""

import argparse
import sys
from pathlib import Path

from . import __version__
from .models import default_models_dir, download_models


def main(argv=None):
    parser = argparse.ArgumentParser(description="cutccc: local Chinese video/audio to SRT")
    parser.add_argument("--version", action="version", version=f"cutccc {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("download", help="Download official Qwen models (~6.5 GB)")
    download.add_argument("--models-dir", type=Path, default=default_models_dir())
    transcribe = commands.add_parser("transcribe", help="Generate Chinese subtitles offline (NVIDIA CUDA)")
    transcribe.add_argument("input", type=Path, help="Local video or audio file")
    transcribe.add_argument("-o", "--output", type=Path, help="New output directory; never overwrite existing directories")
    transcribe.add_argument("--models-dir", type=Path, default=default_models_dir())
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
            transcribe_file(args.input, args.output, args.models_dir)
        elif args.command == "serve":
            import uvicorn
            from .api import create_app
            if not 1 <= args.port <= 65535:
                raise ValueError("Port must be between 1 and 65535")
            app = create_app(args.data_dir, args.models_dir, args.inference_python)
            uvicorn.run(app, host="127.0.0.1", port=args.port, workers=1)
        elif args.command == "mcp":
            from .mcp_server import create_mcp
            create_mcp(args.api_url).run(transport="stdio")
        return 0
    except ImportError as exc:
        print(f"cutccc: optional dependency missing ({exc.name}); install cutccc[web,mcp] or cutccc[inference] as needed", file=sys.stderr)
        return 1
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"cutccc: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("cutccc: interrupted; partial outputs are retained", file=sys.stderr)
        return 130
