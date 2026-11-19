"""Write the JSON Schema of the shared models to apps/engine/schemas/<ModelName>.json.

Web reads these files; CI fails when the committed files differ from what this script writes.
    uv run --project apps/engine python apps/engine/scripts/export_schemas.py
"""

import json
from pathlib import Path

from aftertalk.config.profiles import Profile
from aftertalk.models import JobLimits, LLMConnection, ModelTiers, SpeechConnection, StepUsage, Transcript

OUT = Path(__file__).resolve().parent.parent / "schemas"

MODELS = [LLMConnection, SpeechConnection, ModelTiers, StepUsage, JobLimits, Transcript, Profile]


def render() -> dict[str, str]:
    return {
        f"{model.__name__}.json": json.dumps(model.model_json_schema(mode="validation"), indent=2, ensure_ascii=False)
        + "\n"
        for model in MODELS
    }


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for stale in OUT.glob("*.json"):
        stale.unlink()
    for name, content in render().items():
        (OUT / name).write_text(content, encoding="utf-8", newline="\n")
        print(f"wrote {OUT / name}")
