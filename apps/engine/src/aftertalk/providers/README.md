# providers

Adapters to outside services, built from the settings in each job request (keys
are never stored or logged). `speech/` (transcription, below), `llm.py` and `output.py`
(LLM), `diarization/pyannote.py` (later). Spec: items 65-67, 69.

## LLM

| File | What it does |
| --- | --- |
| `llm.py` | `build_model(conn, http_client=)` turns an `LLMConnection` into a PydanticAI model. It is the only place that reads an LLM key or header (`get_secret_value()`). `open_model(conn, block_private=)` makes the HTTP client, yields the model and always closes the client. `fingerprint(conn)` is a cache key (sha256 of the connection with secrets); never log it. |
| `output.py` | `run_structured(...)` returns a validated object and a `StepUsage`. With `output_mode: auto` it tries tool calls, then a JSON schema in `response_format` (native), then a JSON prompt (prompted). It moves down only when the error means the mode is unsupported: a 400 or 422, native output refused by the profile, or output that is still invalid after PydanticAI's own re-prompts. An answer cut off at the output token limit (`finish_reason` `length`, also a cut-off text answer that PydanticAI re-prompted) is `provider_output_truncated` and stops the ladder: another mode would be cut off at the same limit, so raise the model's output limit or send less. With a fixed `output_mode` the model profile cannot do, the run fails with `provider_config_invalid` before any request. Auth, refusals (`content_filter`), parameter errors about anything but tools or `response_format`, malformed provider responses, network, rate limit, quota, context length and job limits stop it at once. `JobLimits.timeout_seconds` is an overall deadline (`limit_exceeded`) and shortens each request's timeout. A failed run raises an `EngineError` whose `.usage` holds what it used. Transient errors (429, 5xx, dropped connections) are retried inside each mode by PydanticAI's `RetryOnModelErrors`: 3 tries, waiting 1 s then 2 s, each shortened at random by up to half; a 429's `Retry-After` is used when it is 60 s or less, and a longer one is not retried. Usage adds up across modes; `attempts` is the number of modes tried and `requests` counts the requests that got a response. `max_llm_requests` counts requests that got an answer. A request that fails with a retryable error is sent up to 3 times, and those tries are not counted, also not in `usage.requests`. The worst case is 3 HTTP calls per counted request. |
| `errors.py` | `to_engine_error(exc)` maps any provider failure to an `EngineError` code (`models/errors.py`; web gets the codes as `JobError` in `openapi.json`). The error carries a code and a fixed sentence, never the provider's message or body. Raise it `from None`. `provider_output_truncated` means the answer hit the output token limit; `provider_output_invalid` means it was complete but not in the requested format. |
| `net.py` | `make_client(block_private=)`: one `httpx2` client for every provider call; redirects are never followed. With blocking on, each request's host is resolved and refused if any answer is private, loopback, link-local, multicast, reserved or unspecified (also as IPv4-mapped, NAT64 or 6to4), or if the name is `localhost`, `*.localhost` or `*.internal`. The connection is pinned: the request goes to the address that passed the check, with the original name as `Host` and as the TLS server name (certificates are still verified against the name), so a second DNS answer cannot change where it connects. Name resolution is limited by the connect timeout. A connect error or connect timeout moves on to the next address; the first address of the other family (IPv4 or IPv6) is tried second, so a dead family costs one timeout. |

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
`ENGINE_CALLBACK_SECRET`. Engine settings have no prefix: when an `AFTERTALK_`-prefixed form of a setting is
set (`AFTERTALK_BLOCK_PRIVATE_ADDRESSES`), the engine and the command refuse to start and name the right variable.
`AFTERTALK_HOME` is not a setting and stays valid.

### Testing a connection

```sh
aftertalk providers test --kind llm [--tier fast] [--file connections.yaml]
aftertalk --json providers test --kind llm   # {"ok": true, "latency_ms": 420, "output_mode": "tool"}
```

It sends "Reply with the word ok", then probes the output modes with a one-field schema. Exit code 0 ok, 1
provider failure (`{"ok": false, "code": "provider_auth"}`), 2 configuration error. The whole test has a 120 s
limit (`PROBE_TIMEOUT_SECONDS`); running out is `provider_unreachable`. It never prints what the provider sent.

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
| `speech/openai_compatible.py` | The only adapter in M1: `POST {base_url}/audio/transcriptions` with plain `httpx2` (not the OpenAI SDK, so `OPENAI_API_KEY`, `OPENAI_BASE_URL` and `OPENAI_ORG_ID` are never read). It is the only place that reads the key and `extra_headers`. `Authorization: Bearer` is sent only when a key is set. `open_speech(conn, block_private=)` makes the client and closes it. Returns `(Transcript, StepUsage)`; `usage.speech_format` is the rung that worked. |
| `speech/parse.py` | Response to `Transcript`; sets `timing` from what survived parsing. |
| `speech/languages.py` | `normalize_language`: Whisper's full language table with names, ISO 639-2/3 codes, aliases and BCP-47 forms (`polish`, `pl-PL`, `zh-Hans-CN`, `mandarin`, `cym`); unknown to None. |
| `speech/errors.py` | Status and transport failure to an `EngineError` code, on a bare `httpx2.Response`. |

### Request

Multipart: `file`, `model`, `response_format=verbose_json`, the literal field `timestamp_granularities[]` twice
(`word` and `segment`), and `language` and `prompt` when set. Redirects are never followed.

### Format ladder

Servers differ in what they accept, so the request moves down three rungs, one step per rejection:

1. `verbose_json` with `timestamp_granularities[]` (words and segments);
2. `verbose_json` without the granularities (segments only);
3. `json` (text only).

It moves down only on a 400 or 422 whose JSON error `param` or `message` names `timestamp_granularities` (1 to 2) or
`response_format` / `verbose_json` (to 3). Any other 400 or 422 (no param, an HTML body, FastAPI's `detail`, another
param such as `file` or `model`) stops as `provider_bad_response`. The rung that worked is `StepUsage.speech_format`
(`verbose_json`, `verbose_json_segments`, `json`); `attempts` counts every request sent.

### Timing levels

`Transcript.timing` is set from the response, never from the request:

| Level | When | Subtitles |
| --- | --- | --- |
| `word` | at least 90% of the segments have timed words (and at least one word) | yes |
| `segment` | at least 90% of the segments have times; the others stay untimed (`start` and `end` are None) | yes, untimed segments are skipped |
| `none` | text only, or fewer than 90% of the segments have usable times | no (`vtt` and `srt` fail with exit 1) |

Times are never estimated: an untimed segment keeps its text and consumers must treat `None` as "no playback for this segment". `vtt` and `srt` skip such segments and print one stderr note with the count. Words are kept wherever the provider gave them, at every level and always with times; a `word` transcript may have segments without
words (they keep their segment times). Words come at the top level (OpenAI, Groq) and are given to the segment they
overlap most, or nested in the segments (whisper.cpp, with `probability`). Times may be numbers or numeric strings. A
word with a missing, negative, infinite or reversed time is dropped, and a segment with such a time keeps its text:
segment text is never lost (only blank segments are dropped). Words with no segments at all become one segment.
Silence (segments present, none of them) is `segment`.

### Limits and retries

- Upload ceiling: `SpeechConnection.max_upload_mb` (default 25 MiB; Groq's dev tier takes 100). `transcribe` stops
  converting once the encoded audio passes it, and the provider refuses an upload over it before any request:
  `audio_too_long`. A 413 from the server is the same code. No chunking in M1.
- A 429, 5xx, 408 or dropped connection may fail 3 times in all (one budget for all three rungs), waiting 2 s then
  10 s, or `Retry-After` (seconds or an HTTP date, capped at 60 s). A wait that would pass `deadline` (an absolute
  `time.monotonic()` value) fails with `limit_exceeded`. Each request is also bounded by the deadline as a wall-clock
  limit (a server that drips bytes cannot hold it), or by 30 minutes when there is none. Not retried: a blocked
  private address, a 413, a request the client cannot send (`provider_config_invalid`), other HTTP errors
  (`provider_bad_response`) and 429 with `insufficient_quota` (`provider_quota_exceeded`).
- `requests` counts requests that got a response; `attempts` counts every request sent.
- Language: a forced `language` goes through the same table as reported ones (`Polish`, `pl-PL` and `zh-Hans-CN` all
  work; an unknown one is `provider_config_invalid`, and exit 2 on the command line). Without it the provider
  detects the language. With `allowed_languages`, a detected language outside the list, or one we cannot map
  (`klingon`), fails with `language_not_allowed`. A provider that reports no language at all (text-only models)
  cannot be checked and is let through.
- Errors carry a code only, and nothing from the failed request (which holds the `Authorization` header) is chained
  to them. Mapping: 401/403 `provider_auth`; 404 `provider_model_not_found` only when the JSON error code names the
  model, otherwise `provider_bad_response` (often a wrong base URL); 413 `audio_too_long`; 429
  `provider_rate_limited`; 408, 5xx and transport failures `provider_unreachable`; other 4xx, redirects, a 200 that
  is not a transcription and other HTTP client errors `provider_bad_response`.
- `extra_headers` names must be HTTP tokens, values latin-1 without line breaks, and `Host`, `Content-Type`,
  `Content-Length` and `Transfer-Encoding` cannot be set.

### Proxies

The HTTP client never reads the environment: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `.netrc` and
`SSL_CERT_FILE` are ignored, for LLM and speech calls alike. The only proxy is `PROVIDER_PROXY` (an `http://` or
`https://` URL). With `BLOCK_PRIVATE_ADDRESSES=true` a set `PROVIDER_PROXY` is refused (`provider_config_invalid`):
the proxy would resolve and connect to the host itself and so get around the address guard.

### Audio

`audio/encode.py`: `encode_for_speech(path, fmt=)` decodes anything PyAV reads, downmixes to mono, resamples to
16 kHz and writes FLAC or WAV (16-bit PCM) to a temp file in `<tmp>/aftertalk-audio` (mode 0700; files older than an
hour are swept at the start of each call). Use it as a context manager so the file is removed; an interrupt
(`KeyboardInterrupt`, cancellation) removes it too. Audio that starts after 0 (an mp4 whose audio begins at 2 s) or
has timestamp gaps over 0.1 s is padded with silence, so output time 0 is media time 0. Playlists and lists that make
FFmpeg open other files or streams (HLS, concat, ffconcat, SDP, RTP, RTSP, image sequences, tee, pipes) and every
protocol but `file` are refused. No audio stream, or a file that cannot be decoded, is `audio_unreadable`.
Channels are mixed down to mono (M2 adds per-channel handling), and only the first audio stream is read. `SpeechConnection.audio_format` picks the
format: `flac` (default) or `wav` for servers that do not list FLAC (Azure, whisper.cpp without `--convert`).

### Commands

```sh
aftertalk providers test --kind speech       # {"ok": true, "latency_ms": 900, "timing": "word"}
aftertalk transcribe call.mp3 --format vtt --language pl --prompt "Kenobi" --output call.vtt
```

`providers test --kind speech` sends the bundled two-second clip (`assets/test-2s.wav`, macOS text-to-speech; replace
it with a recording we own before a public release; `scripts/make_test_audio.py` rebuilds it). `transcribe` writes
`text` (default), `json`, `vtt` or `srt` to stdout or `--output` (created with mode 0600); progress goes to stderr and never contains
transcript text. `--format json` writes `{"transcript": <Transcript>, "usage": <StepUsage>}`. Exit codes: 0 ok, 1
failure (the code is printed: `failed: provider_auth: ...`, or `{"ok": false, "code": ...}` with `--json`), 2 no
speech connection, bad connections file or bad arguments.
