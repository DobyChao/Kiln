from __future__ import annotations

import codecs
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from itertools import product
from pathlib import Path
from typing import Any

from kiln.parser import build_argv
from kiln.store import Store


def _utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _short_id() -> str:
    return uuid.uuid4().hex[:10]


def expand_sweep(values: dict[str, Any]) -> list[dict[str, Any]]:
    keys: list[str] = []
    options: list[list[Any]] = []
    for key, val in values.items():
        keys.append(key)
        if isinstance(val, list):
            options.append(val if val else [None])
        else:
            options.append([val])
    if not keys:
        return [{}]
    return [dict(zip(keys, combo)) for combo in product(*options)]


def _unwrap(values: dict[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, val in (values or {}).items():
        if isinstance(val, list):
            out[key] = val[0] if val else None
        else:
            out[key] = val
    return out


def _launch_combos(
    values: dict[str, Any],
    override_dims: dict[str, Any] | None,
    sweep: bool,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    override_dims = override_dims or {}
    if sweep:
        v_combos = expand_sweep(values or {})
        o_combos = expand_sweep(override_dims) if override_dims else [{}]
        return [(v, o) for v, o in product(v_combos, o_combos)]
    return [(_unwrap(values), _unwrap(override_dims))]


def parse_gpu_ids(gpu: str | None) -> list[str]:
    if gpu in (None, "", "all"):
        return []
    return [p.strip() for p in str(gpu).split(",") if p.strip() != ""]


def gpu_tokens(gpu: str | None) -> set[str]:
    return set(parse_gpu_ids(gpu))


def assign_gpus(count: int, gpu: str | None, policy: str) -> list[str | None]:
    ids = parse_gpu_ids(gpu)
    if not ids or count <= 0:
        return [None] * count
    if policy == "spread":
        return [ids[i % len(ids)] for i in range(count)]
    joined = ",".join(ids)
    return [joined] * count


def job_brief(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": job.get("id"),
        "script": job.get("script"),
        "status": job.get("status"),
        "gpu": job.get("gpu"),
        "pid": job.get("pid"),
        "group_id": job.get("group_id"),
        "started_at": job.get("started_at"),
        "created_at": job.get("created_at"),
    }


class JobManager:
    def __init__(self, store: Store, logs_dir: Path) -> None:
        self.store = store
        self.logs_dir = logs_dir
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self._procs: dict[str, subprocess.Popen[str]] = {}
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = False
        self.store.mark_interrupted()
        self._worker = threading.Thread(target=self._loop, daemon=True)
        self._worker.start()

    def max_concurrent(self) -> int:
        try:
            return max(1, int(self.store.setting("max_concurrent", "8") or "8"))
        except ValueError:
            return 1

    def gpu_exclusive(self) -> bool:
        return (self.store.setting("gpu_exclusive", "1") or "1") != "0"

    def enqueue(
        self,
        *,
        workspace: dict[str, Any],
        script_rel: str,
        spec: dict[str, Any],
        values: dict[str, Any],
        extra: str = "",
        overrides: list[str] | None = None,
        override_dims: dict[str, Any] | None = None,
        env: dict[str, str] | None = None,
        gpu: str | None = None,
        gpu_policy: str = "pin",
        python: str | None = None,
        cwd: str | None = None,
        sweep: bool = False,
    ) -> list[dict[str, Any]]:
        root = Path(workspace["path"]).resolve()
        script_path = (root / script_rel).resolve()
        script_path.relative_to(root)
        py = python or workspace.get("python") or sys.executable
        workdir = Path(cwd).resolve() if cwd else script_path.parent
        pairs = _launch_combos(values, override_dims, sweep)
        if len(pairs) > 200:
            raise ValueError(f"消融组合过多（{len(pairs)}），上限 200")
        policy = "spread" if gpu_policy == "spread" else "pin"
        assigned = assign_gpus(len(pairs), gpu, policy)
        if policy == "spread":
            pool = parse_gpu_ids(gpu)
            if len(pool) > self.max_concurrent():
                self.store.set_setting("max_concurrent", str(min(64, len(pool))))
        group_id = _short_id() if len(pairs) > 1 else None
        jobs = []
        for (combo, ov_dim), gpu_id in zip(pairs, assigned):
            ov_list = list(overrides or [])
            ov_list.extend(
                f"{k}={v}" for k, v in ov_dim.items() if v not in (None, "")
            )
            argv = build_argv(spec, combo, extra=extra, overrides=ov_list)
            cmd = [str(py), str(script_path), *argv]
            job_id = _short_id()
            log_path = self.logs_dir / f"{job_id}.log"
            display = _format_cmd(cmd)
            job = self.store.add_job(
                {
                    "id": job_id,
                    "workspace_id": workspace["id"],
                    "script": script_rel,
                    "command": display,
                    "cwd": str(workdir),
                    "payload": {
                        "argv": cmd,
                        "values": combo,
                        "extra": extra,
                        "overrides": ov_list,
                        "env": env or {},
                        "python": str(py),
                        "kind": spec.get("kind"),
                        "gpu_policy": policy,
                    },
                    "status": "queued",
                    "log_path": str(log_path),
                    "gpu": gpu_id,
                    "group_id": group_id,
                }
            )
            jobs.append(job)
        self._wake.set()
        return jobs

    def running_count(self) -> int:
        with self._lock:
            return sum(
                1
                for j in self.store.list_jobs(500)
                if j["status"] == "running"
            )

    def stop(self, job_id: str) -> dict[str, Any] | None:
        job = self.store.get_job(job_id)
        if not job:
            return None
        if job["status"] not in {"queued", "running"}:
            return job
        if job["status"] == "queued":
            self.store.update_job(job_id, status="stopped", finished_at=_utc())
            return self.store.get_job(job_id)
        with self._lock:
            proc = self._procs.get(job_id)
        pid = job.get("pid") or (proc.pid if proc else None)
        if pid:
            _kill_tree(int(pid))
        if proc:
            try:
                proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                proc.kill()
        current = self.store.get_job(job_id)
        if current and current["status"] not in {"queued", "running"}:
            return current
        self.store.update_job(job_id, status="stopped", finished_at=_utc())
        self._wake.set()
        return self.store.get_job(job_id)

    def stop_matching(
        self,
        *,
        ids: list[str] | None = None,
        group_id: str | None = None,
        gpu: str | None = None,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        wanted = set(ids or [])
        gpu_set = gpu_tokens(gpu)
        stopped: list[dict[str, Any]] = []
        for job in self.store.list_jobs(400):
            st = job.get("status")
            if st not in {"queued", "running"}:
                continue
            if wanted and job["id"] not in wanted:
                continue
            if group_id and job.get("group_id") != group_id:
                continue
            if gpu_set and not (gpu_tokens(job.get("gpu")) & gpu_set):
                continue
            if status and st != status:
                continue
            result = self.stop(job["id"])
            if result:
                stopped.append(result)
        return stopped

    def shutdown(self) -> None:
        self._stop = True
        self._wake.set()

    def _loop(self) -> None:
        while not self._stop:
            self._dispatch()
            self._wake.wait(timeout=0.8)
            self._wake.clear()

    def _dispatch(self) -> None:
        cap = self.max_concurrent()
        exclusive = self.gpu_exclusive()
        jobs = self.store.list_jobs(400)
        running = [j for j in jobs if j["status"] == "running"]
        queued = [j for j in jobs if j["status"] == "queued"]
        queued.sort(key=lambda j: j.get("created_at") or "")
        slots = max(0, cap - len(running))
        occupied: set[str] = set()
        for job in running:
            occupied |= gpu_tokens(job.get("gpu"))
        started = 0
        for job in queued:
            if started >= slots:
                break
            needed = gpu_tokens(job.get("gpu"))
            if exclusive and needed and needed & occupied:
                continue
            self.store.update_job(job["id"], status="running", started_at=_utc())
            occupied |= needed
            started += 1
            threading.Thread(target=self._run, args=(job,), daemon=True).start()

    def _run(self, job: dict[str, Any]) -> None:
        job_id = job["id"]
        log_path = Path(job["log_path"])
        payload = job.get("payload") or {}
        cmd = payload.get("argv") or _parse_cmd(job["command"])
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        env.setdefault("TERM", "dumb")
        extra_env = payload.get("env") or {}
        for k, v in extra_env.items():
            if v is not None:
                env[str(k)] = str(v)
        if job.get("gpu") not in (None, "", "all"):
            env["CUDA_VISIBLE_DEVICES"] = str(job["gpu"])

        kwargs: dict[str, Any] = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True

        log_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with log_path.open("w", encoding="utf-8", errors="replace", newline="") as log:
                log.write(f"# cwd: {job.get('cwd')}\n")
                log.write(f"# cmd: {job.get('command')}\n")
                if job.get("gpu"):
                    log.write(f"# CUDA_VISIBLE_DEVICES={job.get('gpu')}\n")
                log.write("\n")
                log.flush()
                proc = subprocess.Popen(
                    cmd,
                    cwd=job.get("cwd") or None,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    env=env,
                    bufsize=0,
                    **kwargs,
                )
                with self._lock:
                    self._procs[job_id] = proc
                self.store.update_job(job_id, pid=proc.pid)
                assert proc.stdout is not None
                _pump_output(proc.stdout, log, proc)
                code = proc.wait()
            status = "succeeded" if code == 0 else "failed"
            current = self.store.get_job(job_id)
            if current and current["status"] == "stopped":
                status = "stopped"
            self.store.update_job(
                job_id, status=status, return_code=code, finished_at=_utc()
            )
        except Exception as exc:
            try:
                with log_path.open("a", encoding="utf-8", errors="replace", newline="") as log:
                    log.write(f"\n[kiln] failed to start: {exc}\n")
            except OSError:
                pass
            self.store.update_job(
                job_id, status="failed", finished_at=_utc(), return_code=-1
            )
        finally:
            with self._lock:
                self._procs.pop(job_id, None)
            self._wake.set()


def _pump_output(stream, log, proc: subprocess.Popen | None = None) -> None:
    """Copy bytes as they arrive so tqdm \\r bars show up before a newline."""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    fd = stream.fileno()
    try:
        os.set_blocking(fd, False)
        nonblock = True
    except (OSError, AttributeError, ValueError):
        nonblock = False

    def write_chunk(data: bytes, final: bool = False) -> None:
        text = decoder.decode(data, final=final)
        if text:
            log.write(text)
            log.flush()

    if nonblock:
        idle = 0
        while True:
            try:
                chunk = os.read(fd, 4096)
            except BlockingIOError:
                if proc is not None and proc.poll() is not None:
                    idle += 1
                    if idle >= 8:
                        write_chunk(b"", final=True)
                        return
                time.sleep(0.04)
                continue
            if not chunk:
                if proc is not None and proc.poll() is None:
                    time.sleep(0.04)
                    continue
                write_chunk(b"", final=True)
                return
            idle = 0
            write_chunk(chunk)
        return

    while True:
        chunk = stream.read(1)
        if not chunk:
            write_chunk(b"", final=True)
            return
        write_chunk(chunk if isinstance(chunk, bytes) else chunk.encode("utf-8", "replace"))


def _tail_text(path: str | Path, nbytes: int = 1500) -> str:
    p = Path(path)
    if not p.exists():
        return ""
    try:
        size = p.stat().st_size
        with p.open("rb") as f:
            f.seek(max(0, size - nbytes))
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def attach_tails(jobs: list[dict[str, Any]], nbytes: int = 1500) -> list[dict[str, Any]]:
    for job in jobs:
        if job.get("status") in {"running", "queued"} and job.get("log_path"):
            job["tail"] = _tail_text(job["log_path"], nbytes)
    return jobs


def _format_cmd(cmd: list[str]) -> str:
    parts = []
    for p in cmd:
        if any(ch in p for ch in ' \t\n"'):
            parts.append('"' + p.replace('"', '\\"') + '"')
        else:
            parts.append(p)
    return " ".join(parts)


def _parse_cmd(display: str) -> list[str]:
    import shlex

    posix = sys.platform != "win32"
    return shlex.split(display, posix=posix)


def _kill_tree(pid: int) -> None:
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except OSError:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass


def _complete_utf8_prefix(data: bytes) -> bytes:
    if not data:
        return data
    i = len(data)
    while i > 0 and data[i - 1] & 0xC0 == 0x80:
        i -= 1
    if i == 0:
        return b""
    lead = data[i - 1]
    if lead < 0x80:
        expected = 1
    elif lead < 0xE0:
        expected = 2
    elif lead < 0xF0:
        expected = 3
    elif lead < 0xF8:
        expected = 4
    else:
        return data
    if len(data) - (i - 1) < expected:
        return data[: i - 1]
    return data


def read_log(path: str | Path, offset: int = 0, limit: int = 4000) -> dict[str, Any]:
    p = Path(path)
    if not p.exists():
        return {"text": "", "offset": 0, "size": 0, "eof": True}
    size = p.stat().st_size
    with p.open("rb") as f:
        if offset:
            f.seek(offset)
        data = f.read(limit)
        new_offset = f.tell()
    eof = new_offset >= size
    if not eof:
        complete = _complete_utf8_prefix(data)
        new_offset -= len(data) - len(complete)
        data = complete
    return {
        "text": data.decode("utf-8", errors="replace"),
        "offset": new_offset,
        "size": size,
        "eof": eof,
    }


def preview_plans(
    workspace: dict[str, Any],
    script_rel: str,
    spec: dict[str, Any],
    values: dict[str, Any],
    extra: str = "",
    overrides: list[str] | None = None,
    override_dims: dict[str, Any] | None = None,
    python: str | None = None,
    gpu: str | None = None,
    gpu_policy: str = "pin",
    sweep: bool = False,
) -> list[dict[str, Any]]:
    root = Path(workspace["path"]).resolve()
    script_path = (root / script_rel).resolve()
    py = python or workspace.get("python") or sys.executable
    pairs = _launch_combos(values, override_dims, sweep)
    if len(pairs) > 200:
        raise ValueError(f"消融组合过多（{len(pairs)}），上限 200")
    policy = "spread" if gpu_policy == "spread" else "pin"
    assigned = assign_gpus(len(pairs), gpu, policy)
    out = []
    for (combo, ov_dim), gpu_id in zip(pairs, assigned):
        ov_list = list(overrides or [])
        ov_list.extend(f"{k}={v}" for k, v in ov_dim.items() if v not in (None, ""))
        argv = build_argv(spec, combo, extra=extra, overrides=ov_list)
        out.append(
            {
                "command": _format_cmd([str(py), str(script_path), *argv]),
                "gpu": gpu_id,
            }
        )
    return out
