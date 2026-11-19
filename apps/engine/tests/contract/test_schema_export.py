import importlib.util
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2]


def _render() -> dict[str, str]:
    spec = importlib.util.spec_from_file_location("export_schemas", ENGINE / "scripts" / "export_schemas.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.render()


def test_committed_schemas_match_models() -> None:
    for name, content in _render().items():
        committed = (ENGINE / "schemas" / name).read_text(encoding="utf-8")
        assert committed == content, "run scripts/export_schemas.py and commit schemas/"


def test_no_stale_schema_files() -> None:
    on_disk = {p.name for p in (ENGINE / "schemas").glob("*.json")}
    assert on_disk == set(_render()), "run scripts/export_schemas.py and commit schemas/"
