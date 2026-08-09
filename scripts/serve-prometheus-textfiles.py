#!/usr/bin/env python3
"""Serve bounded *.prom files from one synthetic test-fleet directory.

The reviewed probe writes mode-0600 files as its fixed non-root UID. GitHub-hosted
runners use a different UID, so this test-only collector preserves those
permissions and falls back to the runner's passwordless, non-interactive
``sudo cat`` for files it cannot read directly. Paths are selected only by a
bounded glob beneath the resolved directory.

Multiple probe textfiles repeat Prometheus HELP/TYPE metadata for the same metric
families. A single HTTP exposition may contain each metadata directive only once,
so the collector deduplicates identical directives while preserving every labeled
sample. Conflicting metadata fails closed.
"""

from __future__ import annotations

import argparse
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_FILE_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024


def read_prom_file(directory: Path, path: Path) -> str:
    resolved = path.resolve(strict=True)
    if resolved.parent != directory:
        raise RuntimeError("Prometheus textfile escaped the configured directory")
    if resolved.stat().st_size > MAX_FILE_BYTES:
        raise RuntimeError("Prometheus textfile exceeds the bounded fixture size")
    try:
        return resolved.read_text(encoding="utf-8")
    except PermissionError:
        completed = subprocess.run(
            ["sudo", "--non-interactive", "cat", "--", str(resolved)],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return completed.stdout


def metadata_key(line: str) -> tuple[str, str] | None:
    if line.startswith("# HELP ") or line.startswith("# TYPE "):
        parts = line.split(maxsplit=3)
        if len(parts) < 3:
            raise RuntimeError("Malformed Prometheus metadata directive")
        return parts[1], parts[2]
    return None


def merge_prom_files(directory: Path) -> bytes:
    metadata: dict[tuple[str, str], str] = {}
    output: list[str] = []
    total = 0
    for path in sorted(directory.glob("*.prom")):
        for raw_line in read_prom_file(directory, path).splitlines():
            line = raw_line.rstrip()
            if not line:
                continue
            key = metadata_key(line)
            if key is not None:
                existing = metadata.get(key)
                if existing is not None:
                    if existing != line:
                        raise RuntimeError(
                            f"Conflicting Prometheus metadata for {key[1]}"
                        )
                    continue
                metadata[key] = line
            encoded_length = len(line.encode("utf-8")) + 1
            total += encoded_length
            if total > MAX_RESPONSE_BYTES:
                raise RuntimeError("Prometheus fixture response exceeds its bound")
            output.append(line)
    return ("\n".join(output) + "\n").encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    directory: Path

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path not in {"/", "/metrics"}:
            self.send_error(404)
            return
        body = merge_prom_files(self.directory)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    directory = args.directory.resolve(strict=True)
    Handler.directory = directory
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
