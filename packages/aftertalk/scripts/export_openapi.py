"""Write the engine's OpenAPI schema to packages/aftertalk/openapi.json.

Web's client is generated from this file with Orval; CI fails when the committed
file differs from what this script writes.
    uv run --project packages/aftertalk python packages/aftertalk/scripts/export_openapi.py
"""

import json
import os
from pathlib import Path

os.environ.setdefault("ENGINE_CALLBACK_SECRET", "export-only")

from aftertalk.api.app import app  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "openapi.json"


def render() -> str:
    return json.dumps(app.openapi(), indent=2, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    OUT.write_text(render(), encoding="utf-8", newline="\n")
    print(f"wrote {OUT}")
