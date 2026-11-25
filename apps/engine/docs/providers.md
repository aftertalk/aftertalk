# Providers

Which servers work as a speech connection (`speech:` in `~/.aftertalk/connections.yaml`), and how well. The adapter
is `openai-compatible`: `POST {base_url}/audio/transcriptions`. How it behaves is in
`src/aftertalk/providers/README.md`. The one diarization service, pyannote.ai, is at the end of the compatibility
section.

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

Nothing below has been run against a real provider. The same goes for pyannote.ai: `tests/fake_pyannote.py` imitates
it, and no test calls the real service. A real run is still to be done before merge.

## Compatibility

"From provider docs, not tested" means we read it in the provider's documentation (or in the research notes for this
step) and did not send a request.

| Provider | `base_url` | Model | Timestamps | Notes | Status |
| --- | --- | --- | --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `whisper-1` | words and segments | OpenAI shuts `whisper-1` down on 2027-02-26. | From provider docs, not tested |
| OpenAI | same | `gpt-4o-transcribe`, `gpt-transcribe` | none | Accept only `json` and return just `text` (gpt-transcribe returns `languages[]`); the format ladder handles the 400. `gpt-4o-transcribe` shuts down on 2027-02-26. A text-only transcript cannot become subtitles. | From provider docs, not tested |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3`, `whisper-large-v3-turbo` | words and segments | 25 MB upload on the free tier, 100 MB on the dev tier. The default 25 MiB already fits a 10-minute window, so a higher `max_upload_mb` changes nothing. | From provider docs, not tested |
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

### Diarization (pyannote.ai)

The `diarization:` connection finds the speakers of mixed audio. The adapter is `pyannote-ai`; `base_url` defaults to
`https://api.pyannote.ai/v1` and `api_key` is required.

```yaml
diarization:
  api_key: ${PYANNOTE_API_KEY}
```

`aftertalk transcribe` uses it on mixed audio whenever the file has `diarization:`. `--no-diarize` turns it off;
`--diarize` without a connection exits 2. It uploads the whole recording to pyannote.ai, so the command says so on
stderr first. How it works is in `src/aftertalk/providers/README.md`. What the docs say, and no test confirms:

- Only jobs that succeed are billed, 20 s at least. There is no cancel endpoint, so a job we stop polling (the run was
  cancelled, timed out, or a speech window failed after the job started) runs on and may be billed.
- An upload stays in pyannote.ai's storage for 24 to 48 hours.
- Limits: 1 GiB and 24 hours of audio. A longer file is not diarized: it gets one speaker (`too_long`).

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

## Known limits

- Any length. `aftertalk transcribe` decodes the file once and sends the audio in windows of at most 600 s, one
  request each, in order. A window is also kept under `max_upload_mb` (with a margin: FLAC of noise can be slightly
  larger than WAV), so a smaller limit means shorter windows and more requests. A window is cut at the quietest point
  in its last 30 s when that point is silence, and cut hard at the longest length when there is none (music,
  crosstalk). Windows do not overlap, so a word can be cut in two at a window edge.
- With `--channels mix` every window gets only your `--prompt`; no text is carried from one window to the next.
- Language, in both modes: a forced language, or exactly one allowed language, goes to every window. A call that is
  really English with only Polish allowed then comes back as poor Polish-looking text, not an error. Otherwise
  windows are sent with detection until one returns text, and every window sent after it is forced to that
  window's language; every answer that was sent with detection and has text must be in an allowed language. `mix` tries windows in order. `split` tries the longest of the first five speech segments first, then the
  next longest; filler that the hallucination filter's score rules would drop does not count as text. A window
  without text never fails the language check. A file that switches language part way keeps the decided language.
- `--channels mix` (default) mixes all channels to mono. `--channels split` gives one speaker per channel of a
  two-channel file; any other file is mixed, with a warning. Only the first audio stream is read; files with several
  audio tracks are not handled. Split needs the `[audio]` extra (`pip install 'aftertalk[audio]'`, or
  `uv sync --project apps/engine --extra audio`); without it the command exits 2.
- Split sends one request per speech segment (Silero: threshold 0.4, 250 ms minimum speech, 800 ms minimum silence,
  longest segment 5 min, or less when the upload limit holds less audio; a longer segment is cut into equal pieces,
  and an upload limit under 2 s of audio is `audio_too_long`). That can be hundreds of requests for a 30-minute call, so rate limits matter: at 20
  requests a minute, about 15 minutes. The two channels run in parallel; the windows of one channel run in order.
  Each request's prompt is the last 500 characters of the same channel's text, starting from `--prompt`.
- A "fake stereo" file (the same audio on both channels) transcribed with split gives every sentence twice.
- Audio shorter than 0.1 s is `audio_unreadable` before any request. A relative path with a colon
  ("meeting: monday.wav") works.
- The request form a server accepted is kept for the later windows of the run: a server that rejected word
  timestamps (or `temperature`) is not asked again, so the later windows are not uploaded two or three times.
- Hallucination filter (`split` only; mixed audio is never filtered). Per-segment requests on short speech produce
  filler such as "Dziękuję." A provider segment is dropped, with its words, when
  1. it is shorter than 1 s and its `avg_logprob` is under -0.45;
  2. its `avg_logprob` is under -0.7;
  3. it is shorter than 2 s and its `compression_ratio` is under 0.5;
  4. the same speaker has the same text (stripped, compared exactly) in 3 or more segments of the call.
  A provider that sends no scores gets only the repetition rule. The risk: a real short answer such as "tak" said
  3 or more times by one speaker is dropped. The count is `dropped_segments` in `--format json` output and a line on
  stderr.
- Times are seconds from the start of the file, as a player shows them: an mp4 whose audio starts 45 s in has its
  first word at about 45 s (`source.start_offset_seconds`). The lead-in is not padded. Gaps inside the audio stream
  are filled with silence, at most 30 minutes in one file (more is `audio_unreadable`); a long hold with no packets
  is padded, however short the talk around it.
- Retries: a dropped connection or a 5xx after the upload is still sent again (up to three sends per window), so a
  duplicate bill is at most two extra sends of one window, up to 10 minutes of audio each. A request that timed out
  after the upload is not retried.
- Time limits: `providers test --kind speech` gives up after 120 s. `aftertalk transcribe` gives up after `--timeout`
  seconds, decoding included; the default is 3600 s, or twice the file's duration when that is longer (an unknown
  duration gives 3600 s). Running out is `limit_exceeded`.
- A provider that reports no language (text-only models such as `gpt-4o-transcribe`) fails with
  `language_not_allowed` (`detected_language` null) when several languages are allowed and none is forced. This
  happens on the first window, before the rest is sent. A forced language, a single allowed language or no allowed
  list (the command line) is accepted. `providers test --kind speech` shows `language_reported` so this is seen
  before a call is paid for. When a reported language is refused, the error names it (`detected_language`).
- Without word times a transcript still has words: a segment with no usable word list gets its text split on
  whitespace into words without `start` and `end`. A word time is never estimated or copied from its segment.
- Times are never estimated or moved, except that an end is bounded by the audio sent in its window: an end up to
  1 s past it is cut to it, and a time that starts past it, or ends further past it, is dropped (its text is kept).
  A segment the provider gave no usable time for joins the turn before it, as words
  without times, only when that turn goes on anyway: the next timed word starts less than 1.5 s after the turn's last
  one, so the turn's span holds it. Otherwise (at the start, before a pause of 1.5 s or more, at the end) it is a turn
  of its own with `start` and `end` `None`, so a window answered in plain text (up to 10 minutes of speech) is never
  hidden inside a span of a few seconds. An untimed turn sits in transcript order between its neighbours; its position
  in time is unknown. Treat `None` as "no playback for this segment". The timing level is set on the turns, so a
  window that came back without times can lower it for the whole file. Subtitle output skips untimed turns and says
  how many.
- Output formats: `text` is one turn per line, with a "Label: " prefix when there are 2 or more speakers. `md` starts
  with a header naming the speakers and roles, then one line per turn: `[t12 00:01:23] Agent: ...`, or
  `[t12] Agent: ...` for a turn without times. The ids are the turn ids in the JSON. `vtt` and `srt` cut a turn into
  cues by word times: a new cue starts when the cue would pass 84 characters or 7 s, or after a sentence end once the
  cue is at least 1 s long. With 2 or more speakers a cue starts with the speaker (`<v Label>` in VTT, "Label: " in
  SRT).
- Usage has one entry per step: `decode`, `vad` (split only), `transcribe`, `diarize` (only when a request went to
  pyannote.ai). A run that fails carries the usage of the one step that failed, so the other side's spend is not in it.
- Diarization (mixed audio with a `diarization:` connection; a real `--channels split` never diarizes, but split's
  fallback to mix on a file without two channels does):
  - A request that sends no audio checks the key before the first speech window. The whole mixed track is uploaded
    once, as 16 kHz mono 16-bit WAV (115.2 MB an hour, streamed from the decoded temp file), only after the first
    window with text passed the language and timestamp checks. The windows go on while pyannote.ai works. A failure on
    either side cancels the other, and a diarize failure fails the run (spec #14). A file with no text sends no audio.
  - Polling stops after the larger of 300 s and half the audio's length, and always at the run deadline; both are
    `limit_exceeded`. When the cap was hit, stderr says that a longer `--timeout` does not help.
  - Each request is tried up to 3 times on a connection error, a timeout, 408, 429 (`Retry-After` is honoured) or 5xx.
    `/diarize` is sent again only after a failed connect or an answer of 408, 429 or 5xx; after a timeout, a dropped
    connection or a failed write a job may exist, so it is not. A phase times out after 30 s, a connect after 5 s. The
    upload may take the time left before the deadline (1800 s without one); an upload that used it all is not sent again.
  - Errors: 401 and 403 on a request to `base_url` are `provider_auth`; 402 `provider_quota_exceeded`; 413 on the upload
    `audio_too_long`; a job that failed or was cancelled, and any answer we cannot use, `provider_bad_response`.
  - Speakers: each timed word takes the segment that covers its midpoint (`[start, end)` in ms). A segment without
    word times is one unit, placed by its own midpoint. When several segments cover it, the one that overlaps the word
    most wins, then the shorter, then the earlier. When none covers it, the nearest wins (spec item 68), a tie going to
    the earlier. Speakers are `s1`, `s2`... ("Speaker 1"...) in order of first speech; a pyannote speaker with no words
    is not listed, and there are no roles.
  - Turns: a new turn on a change of speaker, after a gap of 1.5 s inside one speaker, and at the 60 s split. The gap
    rule inside one speaker is a deliberate departure from spec line 1151 and #60.
  - Skipped, with one speaker and `source.diarized` false (`diarization_skipped` in the library, a line on stderr):
    `no_times` (a window with text has no times at all; segment times are enough; a later one cancels the diarization,
    though a job already created may be billed), `too_long`, and
    `no_speakers` (pyannote.ai returned no segments). Whether a file was diarized is `source.diarized`.
  - Security: the presigned upload goes through the same HTTP client, so `BLOCK_PRIVATE_ADDRESSES` checks its host too.
    It must be https unless `base_url` is http, and it carries no `Authorization` header. Without
    `BLOCK_PRIVATE_ADDRESSES` the diarization server can pick any upload host: the same trust as `base_url`.
- On Windows a temp file that is still mapped cannot be deleted at once; it is deleted at the end of the run.
  Windows remains unsupported.
- Subtitles need timestamps. `aftertalk transcribe --format vtt` or `--format srt` fails early when the
  provider returns no times (`timing: none`, for example `gpt-4o-transcribe`): the first answer with text stops the run
  (per channel for split), so the rest is not paid for. The command exits 1 and writes nothing. Segment times are
  enough; word times are not needed. Check the
  `timestamps:` value (`timing` in `--json` output) of `providers test --kind speech` first, or use
  `--format json --output <file>`, which is never refused for lack of times.
- If any window fails after its retries, `aftertalk transcribe` exits 1 and writes nothing in any format; the windows
  already sent are billed. `--format json` does not help here. There is no resume yet: a rerun sends every window
  again, until the transcript cache (a later milestone). No command turns a saved JSON transcript into vtt or srt; the
  JSON only keeps the transcript.
- Windows (the operating system) is not a supported platform in M2.
