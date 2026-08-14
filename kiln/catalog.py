from __future__ import annotations

from pathlib import Path
from typing import Any

from kiln.scanner import inspect_script, scan_scripts
from kiln.store import Store


def resolve_rel(root: Path, raw: str) -> str:
    root = root.resolve()
    p = Path(raw).expanduser()
    p = (root / p).resolve() if not p.is_absolute() else p.resolve()
    try:
        rel = p.relative_to(root)
    except ValueError as exc:
        raise ValueError("脚本必须位于工作区目录内") from exc
    if p.suffix != ".py" or not p.is_file():
        raise ValueError("找不到该 Python 文件")
    return rel.as_posix()


def list_workspace_scripts(
    store: Store,
    ws: dict[str, Any],
    *,
    include_hidden: bool = False,
    rescan: bool = True,
) -> list[dict[str, Any]]:
    root = Path(ws["path"])
    scanned = scan_scripts(root) if rescan else []
    scan_map = {s["path"]: s for s in scanned}
    if rescan:
        store.sync_scanned(int(ws["id"]), list(scan_map))

    out: list[dict[str, Any]] = []
    for entry in store.list_script_entries(int(ws["id"])):
        if entry["hidden"] and not include_hidden:
            continue
        meta = scan_map.get(entry["path"]) or inspect_script(root, entry["path"])
        if not meta:
            meta = {
                "path": entry["path"],
                "name": Path(entry["path"]).name,
                "has_main": False,
                "has_argparse": False,
                "has_hydra": False,
                "has_fire": False,
                "has_click": False,
                "lines": 0,
                "missing": True,
            }
        else:
            meta = dict(meta)
            meta["missing"] = not (root / entry["path"]).is_file()
        meta["source"] = entry["source"]
        meta["hidden"] = bool(entry["hidden"])
        out.append(meta)

    out.sort(
        key=lambda s: (
            bool(s.get("hidden")),
            not s.get("has_main"),
            not (
                s.get("has_argparse")
                or s.get("has_hydra")
                or s.get("has_fire")
                or s.get("has_click")
            ),
            s.get("path") or "",
        )
    )
    return out
