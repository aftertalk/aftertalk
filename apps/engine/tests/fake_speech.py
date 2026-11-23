"""A small OpenAI-compatible transcription server for tests (127.0.0.1, random port)."""

import json
import threading
import time
from dataclasses import dataclass, field
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


@dataclass
class Forced:
    status: int
    body: str = ""
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class Upload:
    filename: str | None
    content_type: str
    size: int


@dataclass
class Seen:
    path: str
    headers: dict[str, str]
    fields: list[tuple[str, str]]  # every non-file form field, in order, repeats kept
    file: Upload | None

    def values(self, name: str) -> list[str]:
        return [v for k, v in self.fields if k == name]


def error_body(message: str = "bad", *, param: str | None = None, code: str | None = None) -> str:
    return json.dumps({"error": {"message": message, "param": param, "code": code, "type": "invalid_request_error"}})


# Shapes the fake can answer with when the request asks for verbose_json.
VERBOSE_TEXT = "Hello there. General Kenobi."
SEGMENTS = [
    {
        "id": 0,
        "start": 0.0,
        "end": 1.2,
        "text": " Hello there.",
        "avg_logprob": -0.2,
        "compression_ratio": 1.1,
        "no_speech_prob": 0.01,
    },
    {
        "id": 1,
        "start": 1.4,
        "end": 2.6,
        "text": " General Kenobi.",
        "avg_logprob": -0.3,
        "compression_ratio": 1.2,
        "no_speech_prob": 0.02,
    },
]
WORDS = [
    {"word": "Hello", "start": 0.0, "end": 0.5},
    {"word": "there.", "start": 0.6, "end": 1.2},
    {"word": "General", "start": 1.4, "end": 2.0},
    {"word": "Kenobi.", "start": 2.1, "end": 2.6},
]


class FakeSpeech:
    def __init__(self) -> None:
        self.seen: list[Seen] = []
        self.forced: list[Forced] = []  # served first, one per request
        self.always: Forced | None = None  # every request gets this
        self.redirect_to: str | None = None
        self.shape = "verbose"  # verbose | segments | words_only | whispercpp | text | languages
        self.reject_verbose = False  # 400 for verbose_json, as Speaches does without the granularities
        self.reject_param: str | None = None  # the param named in that 400 (None: the error names no param)
        self.language = "polish"
        self.reject_granularities = False  # 400 naming timestamp_granularities when they are sent
        self.drip = False  # answer a byte at a time, slowly: never idle long, never finishing
        self.stall = 0.0  # read the whole upload, then wait this many seconds before answering
        self.reject_temperature = False  # 400 naming temperature when the field is sent
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}/v1"

    def start(self) -> None:
        threading.Thread(target=self._server.serve_forever, args=(0.01,), daemon=True).start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def _verbose(self) -> dict:
        base: dict = {"task": "transcribe", "language": self.language, "duration": 2.6, "text": VERBOSE_TEXT}
        match self.shape:
            case "verbose":
                return {**base, "segments": SEGMENTS, "words": WORDS}
            case "segments":
                return {**base, "segments": SEGMENTS}
            case "words_only":
                return {**base, "words": WORDS}
            case "whispercpp":
                nested = [
                    {**SEGMENTS[0], "words": [{**w, "probability": 0.9} for w in WORDS[:2]]},
                    {**SEGMENTS[1], "words": [{**w, "probability": 0.8} for w in WORDS[2:]]},
                ]
                return {**base, "segments": nested}
            case "untimed":  # ten segments, one of them without times
                many = [{**SEGMENTS[0], "id": i, "start": i, "end": i + 1, "text": f" s{i}"} for i in range(10)]
                many[4] = {"id": 4, "text": " no times here"}
                return {**base, "segments": many}
            case "languages":
                return {"text": VERBOSE_TEXT, "languages": [self.language, "english"]}
            case _:
                return {"text": VERBOSE_TEXT}

    def _answer(self, seen: Seen) -> Forced:
        granular = bool(seen.values("timestamp_granularities[]"))
        if self.always is not None:
            return self.always
        if self.forced:
            return self.forced.pop(0)
        if self.redirect_to:
            return Forced(302, "", {"Location": self.redirect_to})
        if self.reject_temperature and seen.values("temperature"):
            return Forced(400, error_body("Unsupported parameter: temperature", param="temperature"))
        verbose = seen.values("response_format") == ["verbose_json"]
        if verbose and granular and self.reject_granularities:
            return Forced(400, error_body("not supported", param="timestamp_granularities[]"))
        if verbose and self.reject_verbose:
            return Forced(400, error_body("not supported", param=self.reject_param))
        if verbose and self.shape != "text":
            data = self._verbose()
            if not granular:
                data.pop("words", None)  # verbose_json without granularities has segments only
            return Forced(200, json.dumps(data))
        if self.shape == "languages":
            return Forced(200, json.dumps(self._verbose()))
        return Forced(200, json.dumps({"text": VERBOSE_TEXT}))

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length)
                head = f"Content-Type: {self.headers.get('Content-Type', '')}\r\nMIME-Version: 1.0\r\n\r\n".encode()
                message = BytesParser(policy=policy.default).parsebytes(head + raw)
                fields: list[tuple[str, str]] = []
                upload: Upload | None = None
                for part in message.iter_parts():
                    name = part.get_param("name", header="content-disposition")
                    filename = part.get_filename()
                    payload = part.get_payload(decode=True) or b""
                    if filename is not None:
                        upload = Upload(filename, part.get_content_type(), len(payload))
                    else:
                        fields.append((str(name), payload.decode()))
                headers = {k.lower(): v for k, v in self.headers.items()}
                seen = Seen(self.path, headers, fields, upload)
                outer.seen.append(seen)
                answer = outer._answer(seen)
                if outer.stall:
                    time.sleep(outer.stall)
                data = answer.body.encode()
                if outer.drip:
                    self.send_response(200)
                    self.send_header("Content-Length", "100000")
                    self.end_headers()
                    try:
                        for _ in range(1000):
                            self.wfile.write(b" ")
                            self.wfile.flush()
                            time.sleep(0.05)
                    except OSError:
                        pass
                    return
                self.send_response(answer.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for k, v in answer.headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: object) -> None:
                pass

        return Handler
