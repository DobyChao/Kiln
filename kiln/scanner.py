from __future__ import annotations

from pathlib import Path
from typing import Any

SKIP_DIRS = {
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "wandb",
    "outputs",
    "output",
    "lightning_logs",
    "runs",
    "tb_logs",
    "tensorboard",
    "checkpoints",
    "ckpt",
    "data",
    "datasets",
    "weights",
    "pretrained",
    "build",
    "dist",
    ".ipynb_checkpoints",
}

SKIP_FILES = {"setup.py", "conftest.py"}


def scan_scripts(root: Path, max_depth: int = 6, limit: int = 800) -> list[dict[str, Any]]:
    root = root.resolve()
    found: list[dict[str, Any]] = []
    if not root.is_dir():
        return found

    for path in root.rglob("*.py"):
        try:
            rel = path.relative_to(root)
        except ValueError:
            continue
        if len(rel.parts) - 1 > max_depth:
            continue
        if any(part in SKIP_DIRS or part.startswith(".") for part in rel.parts[:-1]):
            continue
        if path.name in SKIP_FILES or path.name.startswith("test_"):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        found.append(
            {
                "path": rel.as_posix(),
                "name": path.name,
                "has_main": 'if __name__ == "__main__"' in text
                or "if __name__ == '__main__'" in text,
                "has_argparse": "ArgumentParser" in text or "add_argument" in text,
                "has_hydra": "@hydra.main" in text or "hydra.main" in text,
                "has_fire": "fire.Fire" in text,
                "has_click": "@click." in text,
                "lines": text.count("\n") + 1,
            }
        )
        if len(found) >= limit:
            break

    found.sort(
        key=lambda s: (
            not s["has_main"],
            not (s["has_argparse"] or s["has_hydra"] or s["has_fire"] or s["has_click"]),
            s["path"],
        )
    )
    return found


def inspect_script(root: Path, rel: str) -> dict[str, Any] | None:
    root = root.resolve()
    path = (root / rel).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        return None
    if path.suffix != ".py" or not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return {
        "path": path.relative_to(root).as_posix(),
        "name": path.name,
        "has_main": 'if __name__ == "__main__"' in text or "if __name__ == '__main__'" in text,
        "has_argparse": "ArgumentParser" in text or "add_argument" in text,
        "has_hydra": "@hydra.main" in text or "hydra.main" in text,
        "has_fire": "fire.Fire" in text,
        "has_click": "@click." in text,
        "lines": text.count("\n") + 1,
        "missing": False,
    }
