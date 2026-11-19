# providers

Adapters to outside services, built from the settings in each job request (keys
are never stored or logged). `speech/` (transcription, below), `llm.py` and `output.py`
(LLM), `diarization/pyannote.py` (later). Spec: items 65-67, 69.

## LLM

| File | What it does |
| --- | --- |
| `llm.py` | `build_model(conn, http_client=)` turns an `LLMConnection` into a PydanticAI model. It is the only place that reads an LLM key or header (`get_secret_value()`). `open_model(conn, block_private=)` makes the HTTP client, yields the model and always closes the client. `fingerprint(conn)` is a cache key (sha256 of the connection with secrets); never log it. |
| `output.py` | `run_structured(...)` returns a validated object and a `StepUsage`. With `output_mode: auto` it tries tool calls, then a JSON schema in `response_format` (native), then a JSON prompt (prompted). It moves down only when the error means the mode is unsupported: a 400 or 422, native output refused by the profile, or output that is still invalid after PydanticAI's own re-prompts. Auth, refusals (`content_filter`), parameter errors about anything but tools or `response_format`, malformed provider responses, network, rate limit, quota, context length and job limits stop it at once. `JobLimits.timeout_seconds` is an overall deadline (`limit_exceeded`) and shortens each request's timeout. A failed run raises an `EngineError` whose `.usage` holds what it used. Transient errors (429, 5xx, dropped connections) are retried inside each mode, honouring `Retry-After`. Usage adds up across modes; `attempts` is the number of modes tried and `requests` counts the requests that got a response. |
| `errors.py` | `to_engine_error(exc)` maps any provider failure to an `EngineError` code (`models/errors.py`; web gets the codes as `JobError` in `openapi.json`). The error carries a code and a fixed sentence, never the provider's message or body. Raise it `from None`. |
| `net.py` | `make_client(block_private=)`: one `httpx2` client for every provider call; redirects are never followed. With blocking on, each request's host is resolved and refused if any answer is private, loopback, link-local, multicast, reserved or unspecified (also as IPv4-mapped, NAT64 or 6to4), or if the name is `localhost`, `*.localhost` or `*.internal`. The connection is pinned: the request goes to the address that passed the check, with the original name as `Host` and as the TLS server name (certificates are still verified against the name), so a second DNS answer cannot change where it connects. Name resolution is limited by the connect timeout. |

### Presets

All presets except `anthropic` and `google` use Chat Completions through `OpenAIChatModel`.

| Adapter and preset | Provider class | Notes |
| --- | --- | --- |
| `openai-compatible`, none | `OpenAICompatibleProvider` | Any server. Profile: strict tool schemas off (`PRESET_PROFILES`). |
| `openai-compatible`, `openai` | `OpenAIProvider` | |
| `openai-compatible`, `groq` | `OpenAICompatibleProvider("groq")` | Groq's own provider needs the legacy `httpx` and its SDK; its API is OpenAI-compatible, so `base_url` is `https://api.groq.com/openai/v1`. |
| `openai-compatible`, `vllm` | `VLLMProvider` | |
| `openai-compatible`, `ollama` | `OllamaProvider` | `/v1` is appended to `base_url` when its path does not end in `/v1`. |
| `openai-compatible`, `openrouter` | `OpenRouterProvider` | Model names carry the vendor, for example `openai/gpt-5`. |
| `openai-compatible`, `litellm` | `LiteLLMProvider` | |
| `openai-compatible`, `azure` | `AzureProvider` | `base_url` is the Azure endpoint; `api_version` is required unless the URL ends in `/openai/v1` (the v1 API). |
| `anthropic` | `AnthropicProvider` | Needs the `anthropic` extra. |
| `google` | `GoogleProvider` | Needs the `google` extra. |

A connection without `api_key` sends the placeholder `aftertalk-keyless`, because the OpenAI SDK needs a key and
would otherwise read `OPENAI_API_KEY` from the environment and send it to the configured server. `extra_headers`
become default headers on the HTTP client. `context_window` goes into the model profile.

### `BLOCK_PRIVATE_ADDRESSES`

Environment variable, default `false`. When `true`, LLM calls to private, loopback and link-local addresses
fail with `provider_unreachable`. Turn it on for a shared or hosted engine; leave it off when your own models
run on the same machine (Ollama on `localhost`). The `aftertalk` command reads only this flag, so it needs no
`ENGINE_CALLBACK_SECRET`.

### Testing a connection

```sh
aftertalk providers test --kind llm [--tier fast] [--file connections.yaml]
aftertalk --json providers test --kind llm   # {"ok": true, "latency_ms": 420, "output_mode": "tool"}
```

It sends "Reply with the word ok", then probes the output modes with a one-field schema. Exit code 0 ok, 1
provider failure (`{"ok": false, "code": "provider_auth"}`), 2 configuration error. It never prints what the
provider sent.

### Environment and settings

The provider SDKs read keys, organisations, base URLs, extra headers and Azure or Vertex settings from the
environment (`OPENAI_*`, `ANTHROPIC_*`, `GOOGLE_*`, `GEMINI_*`, `AZURE_*` and others). `build_model` hides those
variables while it builds the clients, so a connection sends only what it configures. Anthropic and Google get
their default base URLs explicitly. A setting the provider rejects when the model is built (for example an
OpenRouter name without its vendor) is `provider_config_invalid`. A 404 is `provider_model_not_found` only when
the provider names the model in its error code; a bare 404 is `provider_bad_response` (often a wrong base URL).

## Speech

`speech/` turns one encoded audio upload into a `Transcript` and a `StepUsage`. Which servers work, and what is
verified, is in `apps/engine/docs/providers.md`.

| File | What it does |
| --- | --- |
| `speech/protocols.py` | `SpeechProvider` (`capabilities`, `transcribe(audio, language=, prompt=, deadline=, allowed_languages=)`) and `SpeechCapabilities` (`word_times`, `segment_times`, `speakers`, `channels`, `max_upload_bytes`). A native adapter such as Deepgram implements the same protocol. `EncodedAudio` (from `audio/encode.py`) is the upload: bytes or a temp file, `filename`, `content_type`, `duration_seconds`, `size_bytes`. |
| `speech/openai_compatible.py` | The only adapter in M1: `POST {base_url}/audio/transcriptions` with plain `httpx2` (not the OpenAI SDK, so `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_ORG_ID` are never read). It is the only place that reads the key and `extra_headers`. `Authorization: Bearer` is sent only when a key is set. `open_speech(conn, block_private=)` makes the client and closes it. `transcribe_detailed` also says whether the fallback ran. |
| `speech/parse.py` | Response to `Transcript`; sets `timing` from what survived parsing. |
| `speech/languages.py` | `normalize_language`: "polish", "pl", "pt-BR" to `pl`, `pl`, `pt`; unknown to None. |
| `speech/errors.py` | Status and transport failure to an `EngineError` code, on a bare `httpx2.Response`. |

### Request

Multipart: `file`, `model`, `response_format=verbose_json`, the literal field `timestamp_granularities[]` twice
(`word` and `segment`), and `language` and `prompt` when set. Redirects are never followed.

### Fallback

Some servers answer a 400 or 422 to `verbose_json` or the granularities (Speaches does without `verbose_json`;
the newer OpenAI models accept only `json`). When the JSON error names `response_format` or
`timestamp_granularities`, or names no parameter, the request is repeated once with `response_format=json` and no
granularities. `StepUsage.attempts` counts both (`transcribe_detailed(...).fallback` is true). An error that names
another parameter (`file`, `model`) is not a fallback case.

### Timing levels

`Transcript.timing` is set from the response, never from the request:

| Level | When | Subtitles |
| --- | --- | --- |
| `word` | every segment with text has timed words | yes |
| `segment` | segments have times, some have no usable words (words are then dropped from all segments) | yes |
| `none` | text only, or a segment without usable times | no (`vtt` and `srt` fail with exit 1) |

Words come at the top level (OpenAI, Groq) and are given to the segment they overlap most, or nested in the
segments (whisper.cpp). A word with a missing, negative, infinite or reversed time is dropped instead of failing the
job, and the level goes down if a segment is left without words. Words with no segments at all become one segment.
Silence (segments present, none of them) is `segment`.

### Limits and retries

- Upload ceiling 25 MB by default (`max_upload_bytes` on the constructor; Groq dev tier takes 100 MB). Above it the
  job fails with `audio_too_long` before any request; a 413 from the server is the same code. No chunking in M1.
- A 429, 5xx, 408 or dropped connection is tried 3 times in all, waiting 2 s then 10 s, or `Retry-After` (capped at
  60 s). A wait that would pass `deadline` (an absolute `time.monotonic()` value) fails with `limit_exceeded` instead.
  A blocked private address, a 413 and 429 with `insufficient_quota` (`provider_quota_exceeded`) are not retried.
- `requests` counts requests that got a response; `attempts` counts every request sent.
- Language: a forced `language` is sent as is. Otherwise the provider detects it, and a detected language outside
  `allowed_languages` fails with `language_not_allowed`. A provider that reports no language (text-only models)
  cannot be checked and is let through.
- Errors carry a code only. Mapping: 401/403 `provider_auth`; 404 `provider_model_not_found` only when the JSON
  error code names the model, otherwise `provider_bad_response` (often a wrong base URL); 413 `audio_too_long`; 429
  `provider_rate_limited`; 408, 5xx and transport failures `provider_unreachable`; other 4xx, redirects and a 200
  that is not a transcription `provider_bad_response`.

### Audio

`audio/encode.py`: `encode_for_speech(path, fmt=)` decodes anything PyAV reads, downmixes to mono, resamples to
16 kHz and writes FLAC or WAV (16-bit PCM) to a temp file. Use it as a context manager so the file is removed.
No audio stream, or a file that cannot be decoded, is `audio_unreadable`. `SpeechConnection.audio_format` picks the
format: `flac` (default) or `wav` for servers that do not list FLAC (Azure, whisper.cpp without `--convert`).

### Commands

```sh
aftertalk providers test --kind speech       # {"ok": true, "latency_ms": 900, "timing": "word"}
aftertalk transcribe call.mp3 --format vtt --language pl --prompt "Kenobi" --output call.vtt
```

`providers test --kind speech` sends the bundled two-second clip (`assets/test-2s.wav`, macOS text-to-speech; replace
it with a recording we own before a public release; `scripts/make_test_audio.py` rebuilds it). `transcribe` writes
`text` (default), `json`, `vtt` or `srt` to stdout or `--output`; progress goes to stderr and never contains
transcript text. `--format json` writes `{"transcript": <Transcript>, "usage": <StepUsage>}`. Exit codes: 0 ok, 1
failure (the code is printed: `failed: provider_auth: ...`, or `{"ok": false, "code": ...}` with `--json`), 2 no
speech connection, bad connections file or bad arguments.
