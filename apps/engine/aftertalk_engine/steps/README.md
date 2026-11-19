# steps

One module per pipeline step: `audio.py` (PyAV decode, channel split), `vad.py`
(Silero), `transcribe.py` (transcribe and diarize, cache first), `analyses/`
(summary, call reason, scorecard, action items; one file each), `quotes.py`
(locate each claim's words in the transcript; a pure function).
Spec: items 63, 64, 68, 73, 74.
