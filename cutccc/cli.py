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
    args = parser.parse_args(argv)
    try:
        if args.command == "download":
            download_models(args.models_dir.expanduser().resolve())
        else:
            from .pipeline import transcribe_file
            transcribe_file(args.input, args.output, args.models_dir)
        return 0
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"cutccc: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("cutccc: interrupted; partial outputs are retained", file=sys.stderr)
        return 130
