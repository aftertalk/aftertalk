# pipeline

A file in, the canonical transcript out. `transcribe.py`: `transcribe_file(path, speech, options, limits, on_event)`
decodes the file once, sends it to the speech provider in windows, shifts every time onto the file's timeline and
returns a `TranscribeResult` (the transcript, one `StepUsage` per step: `decode`, `vad` for split, `transcribe`,
`diarize` when a diarizer was called, `dropped_segments`, and `diarization_skipped`). `on_event` gets step names and window counts, never text.

Two modes, set by `options.channels`:

- `mix` (default): all channels mixed to one speaker. Windows of at most 600 s, sent in order, each with only the
  caller's prompt. With a `diarizer` (`transcribe_file(..., diarizer=)`) the speakers come from it instead; see
  Diarization below.
- `split`: a two-channel file, one speaker per channel (any other file falls back to `mix`, and
  `source.channel_mode` says so). Windows are the speech segments of each channel (`audio/vad.py`, the `[audio]`
  extra; Silero with threshold 0.4, 250 ms minimum speech, 800 ms minimum silence, 5 min longest segment). One
  request per speech segment, so a 30-minute call can mean hundreds of requests. Channels run in parallel, the
  windows of one channel in order; each request's prompt is the last 500 characters of that channel's text so far,
  starting from `--prompt`. After the windows, `filter.py` drops likely hallucinations (see `docs/providers.md`) and
  `turns.build_channel_turns` merges the channels into turns by start time (channel 0 first on ties). A channel
  without speech is a speaker with no turns; a file without speech is an empty transcript and sends no request.

Language, in both modes: a forced language, or exactly one allowed language, goes to every window. Otherwise windows
are sent with detection until one returns text, and that window decides; every window sent after it is forced to
it, and every answer sent with detection that has text must be in an allowed language. In `mix`
the windows are tried in order. In `split` the first five windows of the call (both channels, in time order) are
tried longest first, and filler that the filter's score rules would drop does not count as text. A window without
text never fails the language check.

Diarization (`mix` only; a real `split` never diarizes, but split's fallback to `mix` does). `_Run._mix_diarized` runs
the windows and the diarizer together:

- A key check that sends no audio goes first, before any window. Then the windows start. `_Gate` holds the diarizer
  back until the first window with text has passed the language and timestamp checks; only then the whole mixed track
  (`audio/encode.MonoWav`, 16 kHz mono WAV, streamed from the decoded temp file) is uploaded, once. A file with no text,
  an early speech failure and a provider without times send nothing to it. The windows go on while the diarizer works.
- A failure on either side cancels the other; when both fail, the windows' error is raised (spec #14: a diarize failure
  fails the run). A failed run's error carries the usage of the failing step only: once only diarization is left, the
  step is `diarize`.
- The diarizer heard the track from 0, so its times are shifted by the file's start offset (`_spans`); an end past the
  audio is cut to it, and a segment that starts after it is dropped.
- A skip gives one speaker, `source.diarized` false and `TranscribeResult.diarization_skipped`: `no_times` (a window
  with text has no times at all; segment times still diarize. When it is the first, nothing is uploaded; when a later
  one, the diarization is cancelled and not used, though a job already created may be billed), `too_long` (over the diarizer's upload or length
  limit; nothing is sent, no key check either) and `no_speakers` (it returned no usable segments).
- The `diarize` usage entry comes after `transcribe`, and is there whenever a request went to the diarizer.
- Both sides run together, so timing decides some outcomes: a diarize failure that comes before a later untimed window
  fails the run, although the result would have been one speaker; and when a window fails after a job was created and
  abandoned, the error carries only the transcribe usage.
- The merge (`build_speaker_turns`) runs in a worker thread: a broken answer with thousands of overlapping segments
  does not hold the event loop.
- `source.diarized` is true when the speakers came from the diarizer. Speakers are `s1`, `s2`... ("Speaker 1"...) in
  order of first speech, with no roles.

`turns.py`: `build_turns` regroups the provider segments of one speaker into turns (1.5 s gap, 60 s split; a segment
without times joins the open turn only when the next timed unit continues it, else it is an untimed turn of its own,
in transcript order between its neighbours, its position in time unknown). `build_channel_turns` does it for several
speakers: a gap ends a turn only between two speech segments, and overlapping speech becomes alternating turns.
`build_speaker_turns` does it for mixed audio with diarization: each unit takes the diarization segment that covers
its midpoint (`_SpeakerIndex`: whole milliseconds, `[start, end)`; a word by its own times, a segment without word times
as one unit by its midpoint). When several cover it, the largest overlap with the word wins, then the shorter segment,
then the earlier start; when none does, the nearest (spec item 68), a tie going to the earlier. A turn ends on a change
of speaker, and also after a gap of 1.5 s within one speaker, and at the 60 s split. The gap rule within one speaker is
a deliberate departure from spec line 1151 and #60. A diarization speaker with no words is not listed.
The audio code lives in `audio/`: `decode.py` (decode to a temp PCM file), `windows.py` (where to cut for `mix`),
`vad.py` (speech segments for `split`), `encode.py` (one window as FLAC or WAV in memory; `MonoWav`, the whole track for the diarizer).
Spec: items 63 and 68 (built here and in `audio/`, not in `steps/`) and the Turns section. The step runner (item
61) and the transcript cache (item 62) come later.
