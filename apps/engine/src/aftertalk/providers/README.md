# providers

Adapters to outside services, built from the settings in each job request (keys
are never stored or logged). `protocols.py` and `models.py` (transcription and
diarization interfaces, word model), `speech/openai_compatible.py` (OpenAI, Groq,
self-hosted Whisper), `diarization/pyannote.py`. Spec: items 65-67, 69.

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
