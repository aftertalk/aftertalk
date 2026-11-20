import importlib.util
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2]


def test_committed_openapi_matches_app() -> None:
    spec = importlib.util.spec_from_file_location("export_openapi", ENGINE / "scripts" / "export_openapi.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    committed = (ENGINE / "openapi.json").read_text(encoding="utf-8")
    assert committed == module.render(), "run scripts/export_openapi.py and commit openapi.json"


def test_shared_models_are_in_openapi_components() -> None:
    from aftertalk.api.app import app
    from aftertalk.api.shared_models import SHARED_MODELS

    components = app.openapi()["components"]["schemas"]
    for model, _ in SHARED_MODELS:
        assert model.__name__ in components
