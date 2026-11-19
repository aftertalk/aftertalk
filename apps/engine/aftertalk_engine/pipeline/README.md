# pipeline

Runs one job: `runner.py` runs the steps in order, applies the failure rule and
provider retries, collects per-step metrics; `cache.py` is the transcript cache
under `/data/cache/{cache_namespace}/{audio_sha256}/`; `turns.py` builds turns
from words. Spec: items 61, 62 and the Turns section.
