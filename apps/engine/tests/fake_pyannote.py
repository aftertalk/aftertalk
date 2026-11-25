"""A small pyannote.ai-like diarization server for tests (127.0.0.1, random port)."""

import json
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

MARKER = "PYANNOTE-PROVIDER-MARKER-31"  # in the default error bodies: a test can assert no provider text leaks
SIG = "SIGNATURE-MARKER-55"  # the query string of the default presigned URL


@dataclass
class Forced:
    status: int
    body: str = ""
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class Seen:
    method: str
    path: str  # includes the query string
    headers: dict[str, str]  # lower-cased names
    json: Any  # the parsed JSON body, or None
    body: bytes  # the raw body (the PUT's audio)
    chunked: bool  # the request used Transfer-Encoding: chunked


def segments(*items: tuple[float, float, str]) -> list[dict]:
    return [{"speaker": speaker, "start": start, "end": end} for start, end, speaker in items]


class FakePyannote:
    def __init__(self) -> None:
        self.seen: list[Seen] = []
        self.forced: dict[str, list[Forced]] = {"media": [], "upload": [], "diarize": [], "job": []}
        self.stall: dict[str, float] = {}  # per route: read the request fully, then wait before answering
        self.presigned_url: str | None = None
        self.job_id: str | None = None
        self.statuses: list[str] = ["running", "succeeded"]  # one popped per poll; the last repeats
        self.output: list[dict] = segments((0.0, 1.0, "SPEAKER_00"))
        self.exclusive: list[dict] | None = None
        self.failure_output: dict = {"error": MARKER}
        self.uploads: dict[str, bytes] = {}
        self.jobs: list[dict] = []
        self._media_count = 0
        self._job_count = 0
        self._lock = threading.Lock()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())

    @property
    def _port(self) -> int:
        return self._server.server_address[1]

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._port}/v1"

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self._port}"

    def start(self) -> None:
        threading.Thread(target=self._server.serve_forever, args=(0.01,), daemon=True).start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def requests(self, route: str) -> list[Seen]:
        return [s for s in list(self.seen) if _route(s.method, s.path) == route]

    def _json(self, status: int, data: Any) -> Forced:
        return Forced(status, json.dumps(data))

    def _answer(self, route: str | None, seen: Seen) -> Forced:
        with self._lock:
            if route is not None and self.forced.get(route):
                return self.forced[route].pop(0)
            match route:
                case "media":
                    self._media_count += 1
                    url = self.presigned_url or f"{self.origin}/upload/{self._media_count}?sig={SIG}"
                    return self._json(201, {"url": url})
                case "upload":
                    return Forced(200, "")
                case "diarize":
                    self._job_count += 1
                    job_id = self.job_id or f"job-{self._job_count}"
                    return self._json(200, {"jobId": job_id, "status": "created"})
                case "job":
                    job_id = urlsplit(seen.path).path.rsplit("/", 1)[-1]
                    status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[-1]
                    data: dict[str, Any] = {"jobId": job_id, "status": status}
                    if status == "succeeded":
                        output: dict[str, Any] = {"diarization": self.output}
                        if self.exclusive is not None:
                            output["exclusiveDiarization"] = self.exclusive
                        data["output"] = output
                    elif status in ("failed", "canceled"):
                        data["output"] = self.failure_output
                    return self._json(200, data)
            return self._json(404, {"message": MARKER})

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _read_body(self) -> tuple[bytes, bool]:
                if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
                    out = b""
                    while True:
                        size = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                        if size == 0:
                            while self.rfile.readline().strip():  # trailers, up to the blank line
                                pass
                            return out, True
                        out += self.rfile.read(size)
                        self.rfile.readline()  # the CRLF after each chunk
                return self.rfile.read(int(self.headers.get("Content-Length", "0"))), False

            def _handle(self) -> None:
                raw, chunked = self._read_body()
                parsed: Any = None
                if self.headers.get("Content-Type", "").startswith("application/json") and raw:
                    try:
                        parsed = json.loads(raw)
                    except ValueError:
                        parsed = None
                headers = {k.lower(): v for k, v in self.headers.items()}
                seen = Seen(self.command, self.path, headers, parsed, raw, chunked)
                route = _route(self.command, self.path)
                with outer._lock:
                    outer.seen.append(seen)
                    if route == "upload":
                        outer.uploads[urlsplit(self.path).path] = raw
                    elif route == "diarize" and isinstance(parsed, dict):
                        outer.jobs.append(parsed)
                answer = outer._answer(route, seen)
                delay = outer.stall.get(route or "", 0.0)
                if delay:
                    time.sleep(delay)
                data = answer.body.encode()
                try:
                    self.send_response(answer.status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    for k, v in answer.headers.items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            do_GET = do_POST = do_PUT = _handle

            def log_message(self, *args: object) -> None:
                pass

        return Handler


def _route(method: str, path: str) -> str | None:
    p = urlsplit(path).path
    if method == "POST" and p == "/v1/media/input":
        return "media"
    if method == "PUT" and p.startswith("/upload/"):
        return "upload"
    if method == "POST" and p == "/v1/diarize":
        return "diarize"
    if method == "GET" and p.startswith("/v1/jobs/"):
        return "job"
    return None
