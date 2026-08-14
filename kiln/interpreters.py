from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any


def _conda_roots() -> list[Path]:
    roots: list[Path] = []
    for key in ("CONDA_PREFIX", "CONDA_ROOT"):
        val = os.environ.get(key)
        if val:
            p = Path(val)
            roots.append(p)
            if p.name == "envs":
                roots.append(p.parent)
            elif (p.parent / "envs").is_dir():
                roots.append(p.parent)
    home = Path.home()
    local = Path(os.environ.get("LOCALAPPDATA", "")) if sys.platform == "win32" else Path()
    candidates = [
        home / "miniconda3",
        home / "miniforge3",
        home / "mambaforge",
        home / "anaconda3",
        home / ".conda",
        Path("/opt/conda"),
        Path("/opt/miniconda3"),
        Path("/opt/miniforge3"),
        Path("/usr/local/anaconda3"),
    ]
    if sys.platform == "win32":
        candidates.extend(
            [
                Path("C:/ProgramData/anaconda3"),
                Path("C:/ProgramData/miniconda3"),
                local / "miniconda3",
                local / "anaconda3",
                local / "Continuum" / "anaconda3",
            ]
        )
    roots.extend(candidates)
    seen: set[str] = set()
    out: list[Path] = []
    for r in roots:
        try:
            key = str(r.resolve())
        except OSError:
            continue
        if key in seen or not r.exists():
            continue
        seen.add(key)
        out.append(r)
    return out


def _python_in(env_dir: Path) -> Path | None:
    if sys.platform == "win32":
        exe = env_dir / "python.exe"
        if not exe.exists():
            exe = env_dir / "Scripts" / "python.exe"
    else:
        exe = env_dir / "bin" / "python"
    return exe if exe.exists() else None


def discover_interpreters() -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(path: Path | str | None, label: str, kind: str) -> None:
        if not path:
            return
        p = Path(path)
        try:
            resolved = str(p.resolve())
        except OSError:
            return
        if not p.exists() or resolved in seen:
            return
        seen.add(resolved)
        found.append({"path": resolved, "label": label, "kind": kind})

    add(sys.executable, "当前 Kiln 进程", "current")

    which = shutil.which("python") or shutil.which("python3")
    add(which, "PATH 中的 python", "path")

    conda = shutil.which("conda")
    if conda:
        try:
            raw = subprocess_json(conda)
            for env in raw.get("envs", []):
                exe = _python_in(Path(env))
                name = Path(env).name
                add(exe, f"conda:{name}", "conda")
        except Exception:
            pass

    for root in _conda_roots():
        base_py = _python_in(root)
        add(base_py, f"conda-base:{root.name}", "conda")
        envs = root / "envs"
        if envs.is_dir():
            for env in sorted(envs.iterdir()):
                if env.is_dir():
                    add(_python_in(env), f"conda:{env.name}", "conda")

    return found


def subprocess_json(conda: str) -> dict[str, Any]:
    import subprocess

    out = subprocess.check_output(
        [conda, "env", "list", "--json"],
        timeout=8,
        text=True,
        stderr=subprocess.DEVNULL,
    )
    return json.loads(out)
