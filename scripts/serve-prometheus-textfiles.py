#!/usr/bin/env python3
"""Serve bounded *.prom files from one synthetic test-fleet directory.

The reviewed probe writes mode-0600 files as its fixed non-root UID. GitHub-hosted
runners use a different UID, so this test-only collector preserves those
permissions and falls back to the runner's passwordless, non-interactive
``sudo cat`` for files it cannot read directly. Paths are selected only by a
bounded glob beneath the resolved directory.
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


class Handler(BaseHTTPRequestHandler):
    directory: Path

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
        if self.path not in {"/", "/metrics"}:
            self.send_error(404)
            return
        chunks: list[str] = []
        total = 0
        for path in sorted(self.directory.glob("*.prom")):
            chunk = read_prom_file(self.directory, path).rstrip() + "\n"
            total += len(chunk.encode("utf-8"))
            if total > MAX_RESPONSE_BYTES:
                raise RuntimeError("Prometheus fixture response exceeds its bound")
            chunks.append(chunk)
        body = "".join(chunks).encode("utf-8")
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
