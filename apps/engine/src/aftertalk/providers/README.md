# providers

Adapters to outside services, built from the settings in each job request (keys
are never stored or logged). `protocols.py` and `models.py` (transcription and
diarization interfaces, word model), `speech/openai_compatible.py` (OpenAI, Groq,
self-hosted Whisper), `diarization/pyannote.py`, `llm.py` (one PydanticAI model).
Spec: items 65-67, 69.
