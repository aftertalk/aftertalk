# pipeline

A file in, the canonical transcript out. `transcribe.py`: `transcribe_file(path, speech, options, limits, on_event)`
decodes the file once, sends it to the speech provider in windows, shifts every time onto the file's timeline and
returns a `TranscribeResult` (the transcript, one `StepUsage` per step: `decode`, `vad` for split, `transcribe`, and
`dropped_segments`). `on_event` gets step names and window counts, never text.

Two modes, set by `options.channels`:

- `mix` (default): all channels mixed to one speaker. Windows of at most 600 s, sent in order, each with only the
  caller's prompt.
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

`turns.py`: `build_turns` regroups the provider segments of one speaker into turns (1.5 s gap, 60 s split; a segment
without times joins the open turn only when the next timed unit continues it, else it is an untimed turn of its own,
in transcript order between its neighbours, its position in time unknown). `build_channel_turns` does it for several
speakers: a gap ends a turn only between two speech segments, and overlapping speech becomes alternating turns.
The audio code lives in `audio/`: `decode.py` (decode to a temp PCM file), `windows.py` (where to cut for `mix`),
`vad.py` (speech segments for `split`), `encode.py` (one window as FLAC or WAV in memory).
Spec: items 63 and 68 (built here and in `audio/`, not in `steps/`) and the Turns section. The step runner (item
61) and the transcript cache (item 62) come later.
