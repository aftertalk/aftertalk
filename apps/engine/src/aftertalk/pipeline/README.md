# pipeline

A file in, the canonical transcript out. `transcribe.py`: `transcribe_file(path, speech, options, limits, on_event)`
decodes the file once, sends it to the speech provider in windows, shifts every time onto the file's timeline and
returns a `TranscribeResult` (the transcript and one `StepUsage` per step: `decode`, `transcribe`). `on_event` gets
step names and window counts, never text. `turns.py`: `build_turns`, a pure function that regroups provider segments
into the turns of one speaker (1.5 s gap, 60 s split; a segment without times joins the open turn only when the
next timed unit continues it, else it is an untimed turn of its own, in transcript order between its neighbours, its
position in time unknown). The audio code it uses lives in `audio/`: `decode.py` (decode to a temp PCM file),
`windows.py` (where to cut), `encode.py` (one window as FLAC or WAV in memory).
Spec: items 63 and 68 (built here and in `audio/`, not in `steps/`) and the Turns section. The step runner (item
61) and the transcript cache (item 62) come later.
