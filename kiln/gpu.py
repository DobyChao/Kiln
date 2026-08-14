from __future__ import annotations

import shutil
import subprocess
import sys
from typing import Any

_SKIP_ADAPTERS = (
    "virtual",
    "basic display",
    "remote desktop",
    "microsoft hyper-v",
    "gameviewer",
)


def display_adapters() -> list[str]:
    if sys.platform != "win32":
        return []
    try:
        raw = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }",
            ],
            timeout=6,
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.SubprocessError, OSError, FileNotFoundError):
        return []
    names: list[str] = []
    for line in raw.splitlines():
        name = line.strip()
        if not name:
            continue
        low = name.lower()
        if any(skip in low for skip in _SKIP_ADAPTERS):
            continue
        names.append(name)
    return names


def gpu_info() -> dict[str, Any]:
    adapters = display_adapters()
    smi = shutil.which("nvidia-smi")
    if not smi:
        return {
            "available": False,
            "cuda": False,
            "gpus": [],
            "driver": None,
            "adapters": adapters,
        }
    try:
        driver = subprocess.check_output(
            [smi, "--query-gpu=driver_version", "--format=csv,noheader"],
            timeout=5,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip().splitlines()
        driver_version = driver[0].strip() if driver else None
        raw = subprocess.check_output(
            [
                smi,
                "--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            timeout=5,
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.SubprocessError, OSError, FileNotFoundError):
        return {
            "available": False,
            "cuda": False,
            "gpus": [],
            "driver": None,
            "adapters": adapters,
        }

    gpus = []
    for line in raw.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 6:
            continue
        try:
            gpus.append(
                {
                    "index": int(parts[0]),
                    "name": parts[1],
                    "memory_used": float(parts[2]),
                    "memory_total": float(parts[3]),
                    "utilization": float(parts[4]),
                    "temperature": float(parts[5]),
                }
            )
        except ValueError:
            continue
    return {
        "available": bool(gpus),
        "cuda": bool(gpus),
        "gpus": gpus,
        "driver": driver_version,
        "adapters": adapters,
    }
