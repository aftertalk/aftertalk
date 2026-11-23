# Providers

Which servers work as a speech connection (`speech:` in `~/.aftertalk/connections.yaml`), and how well. The adapter
is `openai-compatible`: `POST {base_url}/audio/transcriptions`. How it behaves is in
`src/aftertalk/providers/README.md`.

## What is tested

Only what the local fake server proves. `tests/fake_speech.py` imitates these response shapes, and the tests in
`tests/unit/test_speech_openai.py`, `test_speech_parse.py` and `test_cli_speech.py` run against it:

- OpenAI and Groq `verbose_json` (top-level `words` and `segments`), segments only, words without segments;
- whisper.cpp (`words` nested in segments, with `probability`);
- text-only `json`, and `languages[]` instead of `language` (gpt-transcribe);
- the format ladder: a 400 naming `timestamp_granularities` (segments only) or `response_format` (plain `json`);
- 429 with and without `Retry-After`, 5xx, 401, 403, 404, 413, a 200 that is not JSON, a redirect;
- `temperature=0` on every request, and one resend without it when a server answers 400 naming `temperature`;
- a server that reads the upload and then does not answer: one request only, never a second (billed) upload.

Nothing below has been run against a real provider.

## Compatibility

"From provider docs, not tested" means we read it in the provider's documentation (or in the research notes for this
step) and did not send a request.

| Provider | `base_url` | Model | Timestamps | Notes | Status |
| --- | --- | --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `whisper-1` | words and segments | OpenAI shuts `whisper-1` down on 2027-02-26. | From provider docs, not tested |
| OpenAI | same | `gpt-4o-transcribe`, `gpt-transcribe` | none | Accept only `json` and return just `text` (gpt-transcribe returns `languages[]`); the format ladder handles the 400. `gpt-4o-transcribe` shuts down on 2027-02-26. A text-only transcript cannot become subtitles. | From provider docs, not tested |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3`, `whisper-large-v3-turbo` | words and segments | 25 MB upload on the free tier, 100 MB on the dev tier (raise `max_upload_bytes`; no chunking until M2). | From provider docs, not tested |
| Together | `https://api.together.xyz/v1` | Whisper models | words and segments (unconfirmed) | If it rejects the granularities the ladder gives segments only, then text only. | From provider docs, not tested |
| OpenRouter | `https://openrouter.ai/api/v1` | vendor-prefixed names | unconfirmed | Check that the model you pick offers transcription; use `providers test --kind speech`. | From provider docs, not tested |
| Speaches | `http://localhost:8000/v1` | `Systran/faster-whisper-...` | words and segments | Answers 400 when granularities are sent without `verbose_json`; the adapter always sends both together. | From provider docs, not tested |
| whisper.cpp server | `http://localhost:8080/v1` | any (ignored) | words nested in segments | Start it with `--inference-path /v1/audio/transcriptions`. Without `--convert` it reads WAV only: set `audio_format: wav`. | From provider docs, not tested |
| vLLM | `http://localhost:8000/v1` | a Whisper model | segments only | No word timestamps, so the transcript is `timing: segment`. | From provider docs, not tested |
| LocalAI | `http://localhost:8080/v1` | a Whisper model | segments | | From provider docs, not tested |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/v1` | your deployment name | as OpenAI | Does not list FLAC: set `audio_format: wav`. Use the v1 base URL; the older `deployments/<name>/audio/transcriptions?api-version=` form is not supported (a `base_url` cannot carry a query string). | From provider docs, not tested |

Example:

```yaml
speech:
  base_url: https://api.groq.com/openai/v1
  api_key: ${GROQ_API_KEY}
  model: whisper-large-v3
  audio_format: flac   # or wav
```

## Spike: word lists and punctuation from real providers

**Not run.** No API keys and no Speaches or whisper.cpp server were available while building this step, so these
questions are open:

1. Does Groq return top-level `words` with the same text as `segments[].text` (punctuation, casing, numerals)?
2. Does OpenAI `whisper-1` attach punctuation to the word text (`"there."`) as the fake server assumes?
3. Does Speaches accept both granularities, and what does its word list look like?
4. How do Together, OpenRouter and LocalAI answer `timestamp_granularities[]`?

To run it (needs the keys or servers, and any short audio file):

```sh
cat > /tmp/spike.yaml <<'EOF'
speech: {base_url: https://api.groq.com/openai/v1, api_key: "${GROQ_API_KEY}", model: whisper-large-v3}
EOF
GROQ_API_KEY=... uv run --project apps/engine aftertalk providers test --kind speech --file /tmp/spike.yaml
GROQ_API_KEY=... uv run --project apps/engine aftertalk transcribe sample.mp3 --connections /tmp/spike.yaml --format json > groq.json

# what the server really sends, before the adapter touches it:
curl -s https://api.groq.com/openai/v1/audio/transcriptions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -F file=@sample.flac -F model=whisper-large-v3 -F response_format=verbose_json \
  -F 'timestamp_granularities[]=word' -F 'timestamp_granularities[]=segment' | python -m json.tool > groq-raw.json

# OpenAI: the same with https://api.openai.com/v1, $OPENAI_API_KEY and model=whisper-1
# Speaches: docker run --rm -p 8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu
#   then base_url http://localhost:8000/v1 and a model it has downloaded
```

Compare `timing`, the number of words per segment and the word text in the JSON output with the raw response, and
update the table above.

## Known limits (M1)

- Audio is always mixed down to mono and only the first audio stream is read. Two-channel calls (one speaker per
  channel) and files with several audio tracks are handled in M2.
- No chunking: audio over `max_upload_mb` fails with `audio_too_long`.
- Silence padding has limits. A gap in the timestamps is filled with silence, measured from media time 0, but MPEG-TS
  and MPEG-PS files and streams that start later than 30 s are measured from their first frame. More than 30 minutes
  of inserted silence, or inserted silence more than 30 s longer than the decoded audio, is `audio_unreadable`.
- Time limits: `providers test --kind speech` gives up after 120 s; `aftertalk transcribe` after `--timeout` seconds
  (default 3600, decoding included). A request that timed out after the upload is not retried, so the audio is never
  billed twice.
- A provider that reports no language (text-only models such as `gpt-4o-transcribe`) fails with
  `language_not_allowed` (`detected_language` null) when several languages are allowed and none is forced; process
  the call again with its language picked. A forced language, a single allowed language or no allowed list (the
  command line) is accepted. `providers test --kind speech` shows `language_reported` so this is seen before a call is
  paid for. When a reported language is refused, the error names it (`detected_language`).
- Without word times a transcript still has words: a segment with no usable word list gets its text split on
  whitespace into words without `start` and `end`. A word time is never estimated or copied from its segment.
- Times are never estimated. A segment the provider gave no usable time for keeps its text with `start` and `end`
  `None` (allowed while at least 90% of the segments are timed); treat `None` as "no playback for this segment".
  Subtitle output skips those segments and says how many.
