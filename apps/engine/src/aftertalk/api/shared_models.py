"""Models web needs before an endpoint uses them, added to the OpenAPI components.

Once a request or response of an endpoint references a model, FastAPI includes it on
its own and the model can be removed from this list.
"""

from typing import Any

from pydantic import BaseModel
from pydantic.json_schema import JsonSchemaMode, models_json_schema

from aftertalk.models import (
    DiarizationConnection,
    JobLimits,
    LLMConnection,
    ModelTiers,
    SpeechConnection,
    StepUsage,
    Transcript,
)
from aftertalk.models.errors import JobError

# Models web sends are listed as they validate; models the engine produces, as they serialize.
SHARED_MODELS: list[tuple[type[BaseModel], JsonSchemaMode]] = [
    (LLMConnection, "validation"),
    (SpeechConnection, "validation"),
    (DiarizationConnection, "validation"),
    (ModelTiers, "validation"),
    (JobLimits, "validation"),
    (StepUsage, "serialization"),
    (Transcript, "serialization"),
    (JobError, "serialization"),
]


def add_shared_models(schema: dict[str, Any]) -> dict[str, Any]:
    _, defs = models_json_schema(SHARED_MODELS, ref_template="#/components/schemas/{model}")
    components = schema.setdefault("components", {}).setdefault("schemas", {})
    for name, model_schema in defs.get("$defs", {}).items():
        if name in components and components[name] != model_schema:
            raise RuntimeError(f"two different schemas are named {name}")
        components[name] = model_schema
    return schema
