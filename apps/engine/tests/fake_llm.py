"""A small OpenAI-compatible chat completions server for tests (127.0.0.1, random port)."""

import json
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


@dataclass
class Forced:
    status: int
    body: str = ""
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class Seen:
    path: str
    headers: dict[str, str]
    body: dict[str, Any]


class FakeLLM:
    def __init__(self) -> None:
        self.seen: list[Seen] = []
        self.forced: list[Forced] = []  # served first, one per request
        self.reject: set[str] = set()  # "tool", "native": answer 400 to that structured output mode
        self.always: Forced | None = None  # every request gets this
        self.redirect_to: str | None = None
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}/v1"

    def start(self) -> None:
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def _answer(self, body: dict[str, Any]) -> Forced:
        if self.always is not None:
            return self.always
        if self.forced:
            return self.forced.pop(0)
        if self.redirect_to:
            return Forced(302, "", {"Location": self.redirect_to})
        message: dict[str, Any] = {"role": "assistant", "content": None}
        probe = json.dumps({"answer": "ok"})
        if body.get("tools"):
            if "tool" in self.reject:
                return Forced(400, json.dumps({"error": {"message": "tools are not supported"}}))
            name = body["tools"][0]["function"]["name"]
            message["tool_calls"] = [
                {"id": "call_1", "type": "function", "function": {"name": name, "arguments": probe}}
            ]
            finish = "tool_calls"
        elif (body.get("response_format") or {}).get("type") == "json_schema":
            if "native" in self.reject:
                return Forced(400, json.dumps({"error": {"message": "response_format is not supported"}}))
            message["content"] = probe
            finish = "stop"
        else:
            wants_json = "JSON" in json.dumps(body["messages"])
            message["content"] = probe if wants_json else "ok"
            finish = "stop"
        completion = {
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "created": 1,
            "model": body.get("model", "m"),
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14},
        }
        return Forced(200, json.dumps(completion))

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                outer.seen.append(Seen(self.path, {k.lower(): v for k, v in self.headers.items()}, body))
                answer = outer._answer(body)
                data = answer.body.encode()
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
