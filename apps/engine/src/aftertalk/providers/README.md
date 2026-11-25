# providers

Adapters to outside services, built from the settings in each job request (keys
are never stored or logged). `speech/` (transcription, below), `llm.py` and `output.py`
(LLM), `diarization/` (speakers, below). Spec: items 65-67, 69.

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
| `speech/protocols.py` | `SpeechProvider` (`capabilities`, `transcribe(audio, language=, prompt=, deadline=, allowed_languages=)`) and `SpeechCapabilities` (`word_times`, `segment_times`, `speakers`, `channels`, `max_upload_bytes`). A native adapter such as Deepgram implements the same protocol. `EncodedAudio` (from `audio/encode.py`) is one upload: bytes in memory, `filename`, `content_type`, `duration_seconds`, `size_bytes`. The pipeline sends one per window and reads only `capabilities.max_upload_bytes` to size the windows. |
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
| `word` | at least 90% of the segments have times on all their words | yes |
| `segment` | at least 90% of the segments have times; the others stay untimed (`start` and `end` are None) | yes, untimed segments are skipped |
| `none` | text only, or fewer than 90% of the segments have usable times | no (`vtt` and `srt` fail with exit 1) |

Times are never estimated or copied: an untimed segment keeps its text and consumers must treat `None` as "no playback
for this segment". `vtt` and `srt` skip such segments and print one stderr note with the count.

Every segment has words, at every level, and they spell its text (letters and digits, lower-cased). A word has `start`
and `end`, or neither. Words come at the top level (OpenAI, Groq) and are given to the timed segment they overlap
most, or nested in the segments (whisper.cpp, with `probability`). When that leaves a segment whose words do not spell
its text, top-level words are lined up with the text of all timed segments at once, so a word timed just past a
segment edge still lands in the right one. A word with a missing, negative, infinite or
reversed time keeps its text without times (a top-level one cannot be placed and is left out), and a word more than
0.5 s (`WORD_SLACK_SECONDS`) outside its timed segment loses its times, before the level is set, so neither can fail
the transcript. A segment whose words do not spell its text gets its text split on whitespace and lined up with
them: a piece that matches a word, or several words that together spell it ("e" "mail" for "e-mail"), takes their
times, the others stay untimed. One wrong word ("ten" for "10") costs only that word its times; the segment then does
not count as word-timed. A consumer that
needs a word's time uses the word's, else its segment's, else there is none. Times may be numbers or numeric strings.
A segment with a bad time keeps its text: segment text is never lost (only blank segments are dropped). Words with no
segments at all become one segment; a text-only answer becomes one untimed segment with split words (`none`).
Silence (segments present, none of them) is `segment`.

### Limits and retries

- Upload ceiling: `SpeechConnection.max_upload_mb` (default 25 MiB; Groq's dev tier takes 100). The pipeline cuts the
  audio into windows that fit it (`audio/windows.py`), and the provider refuses an upload over it before any request:
  `audio_too_long`. A 413 from the server is the same code.
- A 429, 5xx, 408 or dropped connection may fail 3 times in all (one budget for all three rungs), waiting 2 s then
  10 s, or `Retry-After` (seconds or an HTTP date, capped at 60 s). A wait that would pass `deadline` (an absolute
  `time.monotonic()` value) fails with `limit_exceeded`. Each request is also bounded by the deadline as a wall-clock
  limit (a server that drips bytes cannot hold it), or by 30 minutes when there is none. Not retried: a request that
  timed out waiting for the answer (the read timeout or that wall-clock limit; the provider may already have
  transcribed and billed the upload), which is `provider_unreachable` or, past the deadline, `limit_exceeded`; a blocked
  private address, a 413, a request the client cannot send (`provider_config_invalid`), other HTTP errors
  (`provider_bad_response`) and 429 with `insufficient_quota` (`provider_quota_exceeded`).
- `requests` counts requests that got a response; `attempts` counts every request sent.
- `temperature=0` is sent on every rung. A 400 or 422 naming `temperature` gets the same rung once more without it
  (counted in `requests`, not in the retry budget), and the field stays off for the rest of the call.
- Language: a forced `language` goes through the same table as reported ones (`Polish`, `pl-PL` and `zh-Hans-CN` all
  work; an unknown one is `provider_config_invalid`, and exit 2 on the command line). Without it the provider
  detects the language. With `allowed_languages`, a detected language outside the list, or one we cannot map
  (`klingon`), fails with `language_not_allowed`; the error's `detected_language` is the code from our table (`uk`),
  or None when it could not be mapped, never provider text. A provider that reports no language at all (text-only
  models) fails the same way, with `detected_language` None, when several languages are allowed and none is forced:
  redaction rules and prompts need a known language. With one allowed language that language is used; with a forced
  language, or without an allowed list (the command line), the transcript is accepted (`language` is the forced one,
  or None).
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

`audio/decode.py`: `open_decoded(path, max_seconds=)` decodes the first audio stream of anything PyAV reads, once, to
16 kHz 16-bit PCM in a temp file in `<tmp>/aftertalk-audio-<uid>` (mode 0700, owned by the user; files older than an
hour are swept at the start of each call; `<tmp>/aftertalk-audio` on Windows), read back as a memory map. If that name
belongs to someone else or is not a real directory, a fresh private directory with a random name is used and removed
on close. A temp directory that cannot be used is `internal`, not `audio_unreadable`. The file is gone after the
block, also when the await is cancelled or times out (the decoder stops at the next frame) and on an interrupt. Mono
and stereo are kept as they are; more channels are mixed to mono. Sample 0 is the first decoded frame: the lead-in is
not padded, and `start_offset_seconds` says where it sits in the file (the audio stream's first timestamp minus the
container's start time, so MPEG-TS clocks do not count). Gaps inside over 0.1 s are filled with silence; more than
30 minutes of it in one file is `audio_unreadable`. Past `max_seconds` decoding stops with `limit_exceeded`.
`probe_duration(path)` reads the length from the container metadata only (the command line sizes its default
timeout with it).

Playlists and lists that make FFmpeg open other files or streams (HLS, concat, ffconcat, SDP, RTP, RTSP, image
sequences, tee, pipes) and every protocol but `file` are refused. No audio stream, or a file that cannot be decoded,
is `audio_unreadable`.

`audio/windows.py`: `plan_mix_windows` cuts the mono mix into windows of at most 600 s that fit the upload ceiling.
`audio/encode.py`: `encode_pcm(samples, fmt)` encodes one window, in memory, as FLAC or WAV (16-bit PCM, mono,
16 kHz); `SpeechConnection.audio_format` picks it: `flac` (default) or `wav` for servers that do not list FLAC (Azure,
whisper.cpp without `--convert`). `open_encoded` (the whole file as one upload) is used only by `providers test`.
`MonoWav` is the whole decoded track mixed to mono as 16-bit WAV for diarization: it is streamed from the decoded temp
file in 1 MiB chunks and never built in memory, and `chunks()` starts again from the header, so a retried upload sends
it whole.

### Commands

```sh
aftertalk providers test --kind speech       # {"ok": true, "latency_ms": 900, "timing": "word", "language_reported": true}
aftertalk transcribe call.mp3 --format vtt --language pl --prompt "Kenobi" --output call.vtt --timeout 600
```

`providers test --kind speech` sends the bundled two-second clip (`assets/test-2s.wav`, macOS text-to-speech; replace
it with a recording we own before a public release; `scripts/make_test_audio.py` rebuilds it). `language_reported` is
false when the answer held no language we recognise: such a connection fails with `language_not_allowed` whenever
several languages are allowed and none is forced. `transcribe` writes
`text` (default), `json`, `vtt` or `srt` to stdout or `--output` (created with mode 0600); progress goes to stderr
(decoding, the audio length, `transcribing window 2/5`) and never contains transcript text. `--format json` writes
`{"transcript": <Transcript>, "usage": [<StepUsage>, ...]}`, one usage entry per step (`decode`, then `transcribe`
with the windows summed and the lowest `speech_format` any window needed). Time limits: `providers test` gives up
after 120 s (`provider_unreachable`); `transcribe --timeout SECONDS` covers decoding and every window, and running
out is `limit_exceeded`. Its default is 3600 s, or twice the file's duration when that is longer. Exit codes: 0 ok, 1 failure (the code is printed: `failed: provider_auth: ...`, or
`{"ok": false, "code": ...}` with `--json`; `language_not_allowed` adds the detected language, `(detected: uk)` or
`"detected_language": "uk"`), 2 no speech connection, bad connections file, bad arguments or a setting spelled with
the `AFTERTALK_` prefix.

## Diarization

`diarization/` finds who speaks when in mixed audio. It is separate from speech (spec #6). The pipeline gives the
provider the whole mixed track and assigns the words to speakers itself (`pipeline/turns.build_speaker_turns`); the
provider's speaker labels are grouping keys and never leave the engine.

| File | What it does |
| --- | --- |
| `diarization/protocols.py` | `DiarizationProvider` (`name`, `capabilities`, `check(deadline=)`, `diarize(audio, deadline=)`, `usage()`), `DiarizationCapabilities` (`max_upload_bytes`, `max_audio_seconds`), `DiarizationUpload` (`chunks()`, `size_bytes`, `duration_seconds`, `content_type`) and the output types (`DiarizationSegment`, `DiarizationOutput`). |
| `diarization/pyannote.py` | The only adapter: `pyannote-ai`. `open_diarization(conn, block_private=)` makes the client, yields the provider and closes the client. One instance per run: it sums the run's requests into one `StepUsage` (`step` `diarize`, `provider` `pyannote-ai`, `model` `community-1`). It is the only place that reads the key. |

### Connection

`DiarizationConnection` (`diarization:` in the connections file): `adapter` (`pyannote-ai`, the default), `base_url`
(default `https://api.pyannote.ai/v1`) and `api_key` (required).

```yaml
diarization:
  api_key: ${PYANNOTE_API_KEY}
```

### Flow

1. `check`: `POST {base_url}/media/input`, which sends no audio. A rejected key fails here, before any speech window.
2. After the first speech window with text has passed the language and timestamp checks, `diarize` asks
   `POST {base_url}/media/input` for an upload address and `PUT`s the whole mixed track there, once, as 16 kHz mono
   16-bit WAV (115.2 MB an hour). The windows go on meanwhile.
3. `POST {base_url}/diarize` with `model: community-1` and `exclusive: true` creates the job. `exclusiveDiarization` is
   read from the answer when it has it.
4. `GET {base_url}/jobs/{id}` every 2 s until the job has succeeded. The job id must match `[A-Za-z0-9_-]{1,128}`.

A failure on either side (windows or diarization) cancels the other (spec failure rule #14: a diarize failure fails the
run). A file over 1 GiB or 24 hours is not sent: it is transcribed with one speaker (`too_long`).

### Limits and retries

- Each request is tried up to 3 times on a connection error, a timeout, 408, 429 or 5xx, waiting 2 s then 10 s, or
  `Retry-After`. A wait that would pass the deadline is `limit_exceeded`. A phase times out after 30 s, a connect after
  5 s. `/diarize` is sent again only after a failed connect or an answer of 408, 429 or 5xx: after a timeout, a dropped
  connection or a failed write a job may exist, and there is no endpoint to cancel one. The upload may take the time
  left before the deadline (1800 s without one), and an upload that used all of it is not sent again.
- The HTTP client loggers (`httpx`, `httpx2`, `httpcore`, `httpcore2`) are set to WARNING when `providers/net.py` is
  imported: they log request URLs, and a presigned upload URL carries its signature.
- Polling stops after the larger of 300 s and half the audio's length, and always at the run's deadline. Both are
  `limit_exceeded`; the first is `PollingTimeout`, so the command can say that a longer `--timeout` does not help.
- Errors carry a code and the usage so far, never provider text, the upload address or the key: 401 and 403
  `provider_auth` (on the upload itself, which has no key, `provider_bad_response`); 402 `provider_quota_exceeded`; 413
  on the upload `audio_too_long`; 429 `provider_rate_limited`; 408, 5xx and transport failures `provider_unreachable`;
  a job that failed or was cancelled, a bad answer and any other 4xx `provider_bad_response`.
- `usage.requests` counts requests that got a response, `attempts` every request sent, polls and the key check
  included. `audio_seconds` is set once job creation was attempted, because from then on a job may be billed. The entry
  is in the result whenever a request went to pyannote.ai.

### Security

The key goes only to requests on `{base_url}`, never to the upload host. The presigned upload goes through the same
`make_client`, so `BLOCK_PRIVATE_ADDRESSES` checks its host too, and redirects are never followed. The address must be
https unless `base_url` is http, and it is never logged or put in an error. Without `BLOCK_PRIVATE_ADDRESSES` the
diarization server can pick any upload host: the same trust as `base_url`.

### Billing and retention

From pyannote.ai's documentation; the real API has not been tried. Only succeeded jobs are billed, 20 s at least. A job
we stop polling (cancel, timeout, a speech window that fails after the job started) runs on and may be billed. An
upload stays in pyannote.ai's storage for 24 to 48 hours. The limits are 1 GiB and 24 hours.
