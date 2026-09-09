#!/usr/bin/env python3
"""Small local-only /runtime/fs fixture for the agent image boundary smoke.

It intentionally has no authentication, account, or model integration. The
smoke passes a throwaway token so the real image exercises token-file handling
without contacting a Cumora deployment.
"""

from __future__ import annotations

import argparse
import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class FixtureState:
    def __init__(self, state_path: Path) -> None:
        self.files: dict[str, str] = {}
        self.lock = threading.Lock()
        self.state_path = state_path

    def snapshot(self) -> None:
        self.state_path.write_text(
            json.dumps(self.files, sort_keys=True), encoding="utf-8"
        )


class Handler(BaseHTTPRequestHandler):
    state: FixtureState

    def log_message(self, *_args: object) -> None:
        # Keep smoke output free of request data and token-bearing headers.
        return

    def reply(self, status: int, value: object) -> None:
        body = json.dumps(value, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def request_path(self) -> str:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        return query.get("path", [""])[0]

    def do_GET(self) -> None:  # noqa: N802
        url_path = urllib.parse.urlsplit(self.path).path
        path = self.request_path()
        with self.state.lock:
            if url_path == "/runtime/fs/stat":
                if path == "":
                    return self.reply(200, {"exists": True, "isDir": True, "size": 0})
                value = self.state.files.get(path)
                return self.reply(
                    200,
                    {"exists": value is not None, "isDir": False, "size": len(value or "")},
                )
            if url_path == "/runtime/fs/read":
                if path not in self.state.files:
                    return self.reply(404, {})
                return self.reply(200, {"body": self.state.files[path]})
            if url_path == "/runtime/fs/list":
                prefix = f"{path}/" if path else ""
                names: set[str] = set()
                for key in self.state.files:
                    if key.startswith(prefix):
                        remainder = key[len(prefix) :]
                        if remainder:
                            names.add(remainder.split("/", 1)[0])
                return self.reply(
                    200,
                    {
                        "entries": [
                            {"name": name, "isDir": False} for name in sorted(names)
                        ]
                    },
                )
        return self.reply(404, {})

    def do_PUT(self) -> None:  # noqa: N802
        url_path = urllib.parse.urlsplit(self.path).path
        if url_path != "/runtime/fs/write":
            return self.reply(404, {})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            value = json.loads(self.rfile.read(length))
            path = value["path"]
            body = value["body"]
            if not isinstance(path, str) or not isinstance(body, str) or not path:
                raise ValueError("invalid fixture write")
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            return self.reply(400, {})
        with self.state.lock:
            self.state.files[path] = body
            self.state.snapshot()
        return self.reply(200, {"ok": True})

    def do_DELETE(self) -> None:  # noqa: N802
        url_path = urllib.parse.urlsplit(self.path).path
        if url_path != "/runtime/fs/unlink":
            return self.reply(404, {})
        path = self.request_path()
        with self.state.lock:
            self.state.files.pop(path, None)
            self.state.snapshot()
        return self.reply(200, {"ok": True})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--state", type=Path, required=True)
    args = parser.parse_args()
    args.state.unlink(missing_ok=True)
    state = FixtureState(args.state)
    Handler.state = state
    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(server.server_port, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
