# providers

Adapters to outside services, built from the settings in each job request (keys
are never stored or logged). `protocols.py` and `models.py` (transcription and
diarization interfaces, word model), `speech/openai_compatible.py` (OpenAI, Groq,
self-hosted Whisper), `diarization/pyannote.py`. Spec: items 65-67, 69.

## LLM

| File | What it does |
| --- | --- |
| `llm.py` | `build_model(conn, http_client=)` turns an `LLMConnection` into a PydanticAI model. It is the only place that reads an LLM key or header (`get_secret_value()`). `open_model(conn, block_private=)` makes the HTTP client, yields the model and always closes the client. `fingerprint(conn)` is a cache key (sha256 of the connection with secrets); never log it. |
| `output.py` | `run_structured(...)` returns a validated object and a `StepUsage`. With `output_mode: auto` it tries tool calls, then a JSON schema in `response_format` (native), then a JSON prompt (prompted). It moves down only when the error means the mode is unsupported: a 400 or 422, native output refused by the profile, or output that is still invalid after PydanticAI's own re-prompts. Auth, network, rate limit, quota, context length and job limits stop it at once. Transient errors (429, 5xx, dropped connections) are retried inside each mode, honouring `Retry-After`. Usage adds up across modes; `attempts` is the number of modes tried and `requests` counts the requests that got a response. |
| `errors.py` | `to_engine_error(exc)` maps any provider failure to an `EngineError` code (`models/errors.py`; web gets the codes as `JobError` in `openapi.json`). The error carries a code and a fixed sentence, never the provider's message or body. Raise it `from None`. |
| `net.py` | `make_client(block_private=)`: one `httpx2` client for every provider call; redirects are never followed. With blocking on, each request's host is resolved and refused if any answer is private, loopback, link-local, multicast, reserved or unspecified (also as IPv4-mapped, NAT64 or 6to4), or if the name is `localhost`, `*.localhost` or `*.internal`. The check does not pin the connection to the address it validated, so DNS rebinding can get past it. |

### Presets

All presets except `anthropic` and `google` use Chat Completions through `OpenAIChatModel`.

| Adapter and preset | Provider class | Notes |
| --- | --- | --- |
| `openai-compatible`, none | `OpenAICompatibleProvider` | Any server. Profile: strict tool schemas off (`PRESET_PROFILES`). |
| `openai-compatible`, `openai` | `OpenAIProvider` | |
| `openai-compatible`, `groq` | `OpenAICompatibleProvider("groq")` | Groq's own provider needs the legacy `httpx` and its SDK; its API is OpenAI-compatible, so `base_url` is `https://api.groq.com/openai/v1`. |
| `openai-compatible`, `vllm` | `VLLMProvider` | |
| `openai-compatible`, `ollama` | `OllamaProvider` | |
| `openai-compatible`, `openrouter` | `OpenRouterProvider` | Model names carry the vendor, for example `openai/gpt-5`. |
| `openai-compatible`, `litellm` | `LiteLLMProvider` | |
| `openai-compatible`, `azure` | `AzureProvider` | `base_url` is the Azure endpoint; `api_version` is required. |
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
