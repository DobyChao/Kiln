from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from kiln import __version__
from kiln.catalog import list_workspace_scripts, resolve_rel
from kiln.gpu import gpu_info
from kiln.interpreters import discover_interpreters
from kiln.jobs import JobManager, attach_tails, gpu_tokens, job_brief, preview_plans, read_log
from kiln.parser import parse_cli, parse_script
from kiln.store import Store

PKG_DIR = Path(__file__).resolve().parent
STATIC_DIR = PKG_DIR / "static"
EXAMPLES_DIR = PKG_DIR / "examples"
DATA_DIR = Path.home() / ".kiln"


class WorkspaceIn(BaseModel):
    name: str
    path: str
    python: str | None = None


class WorkspacePatch(BaseModel):
    name: str | None = None
    python: str | None = None


class ScriptIn(BaseModel):
    path: str


class ScriptHideIn(BaseModel):
    path: str | None = None
    paths: list[str] | None = None
    hidden: bool = True


class PresetIn(BaseModel):
    workspace_id: int
    script: str
    name: str
    payload: dict[str, Any]


class LaunchIn(BaseModel):
    workspace_id: int
    script: str
    values: dict[str, Any] = Field(default_factory=dict)
    extra: str = ""
    overrides: list[str] = Field(default_factory=list)
    override_dims: dict[str, Any] = Field(default_factory=dict)
    env: dict[str, str] = Field(default_factory=dict)
    gpu: str | None = None
    gpu_policy: str = "pin"
    python: str | None = None
    cwd: str | None = None
    sweep: bool = False


class ParseCliIn(BaseModel):
    workspace_id: int
    script: str
    command: str


class SettingsIn(BaseModel):
    max_concurrent: int | None = None
    gpu_exclusive: bool | None = None


class StopBatchIn(BaseModel):
    ids: list[str] | None = None
    group_id: str | None = None
    gpu: str | None = None
    status: str | None = None


def _safe_script(root: Path, rel: str) -> Path:
    full = (root / rel).resolve()
    try:
        full.relative_to(root.resolve())
    except ValueError as exc:
        raise HTTPException(400, "脚本路径超出工作区") from exc
    if full.suffix != ".py" or not full.is_file():
        raise HTTPException(404, "找不到该 Python 脚本")
    return full


def create_app(data_dir: Path | None = None) -> FastAPI:
    data = data_dir or DATA_DIR
    store = Store(data / "kiln.db")
    jobs = JobManager(store, data / "logs")

    app = FastAPI(title="Kiln", version=__version__)
    app.state.store = store
    app.state.jobs = jobs

    @app.get("/api/meta")
    def meta() -> dict[str, Any]:
        return {
            "version": __version__,
            "python": sys.executable,
            "platform": sys.platform,
            "examples": str(EXAMPLES_DIR) if EXAMPLES_DIR.is_dir() else None,
            "data_dir": str(data),
        }

    @app.get("/api/gpu")
    def api_gpu() -> dict[str, Any]:
        info = gpu_info()
        listed = store.list_jobs(400)
        running = [j for j in listed if j["status"] == "running"]
        queued = [j for j in listed if j["status"] == "queued"]
        for card in info["gpus"]:
            idx = str(card["index"])
            card["running"] = [
                job_brief(j) for j in running if idx in gpu_tokens(j.get("gpu"))
            ]
            card["queued"] = [
                job_brief(j) for j in queued if idx in gpu_tokens(j.get("gpu"))
            ]
        info["running_count"] = len(running)
        info["queued_count"] = len(queued)
        info["max_concurrent"] = jobs.max_concurrent()
        info["gpu_exclusive"] = jobs.gpu_exclusive()
        return info

    @app.get("/api/interpreters")
    def api_interpreters() -> dict[str, Any]:
        return {"interpreters": discover_interpreters()}

    @app.get("/api/settings")
    def api_settings() -> dict[str, Any]:
        return {
            "max_concurrent": jobs.max_concurrent(),
            "gpu_exclusive": jobs.gpu_exclusive(),
        }

    @app.post("/api/settings")
    def api_set_settings(body: SettingsIn) -> dict[str, Any]:
        if body.max_concurrent is not None:
            if body.max_concurrent < 1 or body.max_concurrent > 64:
                raise HTTPException(400, "max_concurrent 需在 1–64")
            store.set_setting("max_concurrent", str(body.max_concurrent))
        if body.gpu_exclusive is not None:
            store.set_setting("gpu_exclusive", "1" if body.gpu_exclusive else "0")
        return {
            "max_concurrent": jobs.max_concurrent(),
            "gpu_exclusive": jobs.gpu_exclusive(),
        }

    @app.get("/api/workspaces")
    def api_workspaces() -> dict[str, Any]:
        return {"workspaces": store.list_workspaces()}

    @app.post("/api/workspaces")
    def api_add_workspace(body: WorkspaceIn) -> dict[str, Any]:
        path = Path(body.path).expanduser().resolve()
        if not path.is_dir():
            raise HTTPException(400, f"目录不存在: {path}")
        name = body.name.strip() or path.name
        try:
            return store.add_workspace(name, str(path), body.python)
        except Exception as exc:
            raise HTTPException(400, f"无法添加工作区: {exc}") from exc

    @app.post("/api/workspaces/examples")
    def api_add_examples() -> dict[str, Any]:
        if not EXAMPLES_DIR.is_dir():
            raise HTTPException(404, "示例目录不存在")
        existing = next(
            (w for w in store.list_workspaces() if w["path"] == str(EXAMPLES_DIR.resolve())),
            None,
        )
        if existing:
            return existing
        return store.add_workspace("Kiln 示例", str(EXAMPLES_DIR.resolve()), sys.executable)

    @app.patch("/api/workspaces/{ws_id}")
    def api_patch_workspace(ws_id: int, body: WorkspacePatch) -> dict[str, Any]:
        ws = store.update_workspace(ws_id, body.name, body.python)
        if not ws:
            raise HTTPException(404, "工作区不存在")
        return ws

    @app.delete("/api/workspaces/{ws_id}")
    def api_delete_workspace(ws_id: int) -> dict[str, Any]:
        store.delete_workspace(ws_id)
        return {"ok": True}

    @app.get("/api/workspaces/{ws_id}/scripts")
    def api_scripts(ws_id: int, hidden: bool = False) -> dict[str, Any]:
        ws = store.get_workspace(ws_id)
        if not ws:
            raise HTTPException(404, "工作区不存在")
        entries = store.list_script_entries(ws_id)
        # 空列表才扫一次，且只收可启动脚本，避免把仓库里成百上千个 .py 倒进运行列表
        scripts = list_workspace_scripts(
            store,
            ws,
            include_hidden=hidden,
            rescan=not entries,
            scan_mode="launchable",
        )
        return {"workspace": ws, "scripts": scripts}

    @app.post("/api/workspaces/{ws_id}/scripts/scan")
    def api_rescan(ws_id: int, hidden: bool = False, mode: str = "launchable") -> dict[str, Any]:
        ws = store.get_workspace(ws_id)
        if not ws:
            raise HTTPException(404, "工作区不存在")
        if mode not in {"launchable", "all"}:
            raise HTTPException(400, "mode 需为 launchable 或 all")
        scripts = list_workspace_scripts(
            store, ws, include_hidden=hidden, rescan=True, scan_mode=mode
        )
        return {"workspace": ws, "scripts": scripts, "count": len(scripts), "mode": mode}

    @app.post("/api/workspaces/{ws_id}/scripts")
    def api_add_script(ws_id: int, body: ScriptIn) -> dict[str, Any]:
        ws = store.get_workspace(ws_id)
        if not ws:
            raise HTTPException(404, "工作区不存在")
        try:
            rel = resolve_rel(Path(ws["path"]), body.path)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        entry = store.upsert_script(ws_id, rel, source="manual", hidden=0)
        return {"ok": True, "entry": entry, "path": rel}

    @app.post("/api/workspaces/{ws_id}/scripts/hide")
    def api_hide_script(ws_id: int, body: ScriptHideIn) -> dict[str, Any]:
        ws = store.get_workspace(ws_id)
        if not ws:
            raise HTTPException(404, "工作区不存在")
        paths = list(body.paths or [])
        if body.path:
            paths.append(body.path)
        if not paths:
            raise HTTPException(400, "需要 path 或 paths")
        count = store.set_scripts_hidden(ws_id, paths, body.hidden)
        return {"ok": True, "count": count}

    @app.delete("/api/workspaces/{ws_id}/scripts")
    def api_delete_script(ws_id: int, path: str) -> dict[str, Any]:
        ws = store.get_workspace(ws_id)
        if not ws:
            raise HTTPException(404, "工作区不存在")
        store.delete_script_entry(ws_id, path)
        return {"ok": True}

    @app.get("/api/workspaces/{ws_id}/parse")
    def api_parse(ws_id: int, script: str) -> dict[str, Any]:
        ws = store.get_workspace(ws_id)
        if not ws:
            raise HTTPException(404, "工作区不存在")
        path = _safe_script(Path(ws["path"]), script)
        spec = parse_script(path)
        spec["script"] = script
        spec["abs"] = str(path)
        return spec

    @app.post("/api/parse-cli")
    def api_parse_cli(body: ParseCliIn) -> dict[str, Any]:
        ws = store.get_workspace(body.workspace_id)
        if not ws:
            raise HTTPException(404, "工作区不存在")
        path = _safe_script(Path(ws["path"]), body.script)
        spec = parse_script(path)
        if not (body.command or "").strip():
            raise HTTPException(400, "请粘贴一条命令")
        parsed = parse_cli(spec, body.command)
        parsed["kind"] = spec.get("kind")
        return parsed

    @app.get("/api/presets")
    def api_presets(workspace_id: int, script: str) -> dict[str, Any]:
        return {"presets": store.list_presets(workspace_id, script)}

    @app.post("/api/presets")
    def api_add_preset(body: PresetIn) -> dict[str, Any]:
        return store.add_preset(body.workspace_id, body.script, body.name, body.payload)

    @app.delete("/api/presets/{preset_id}")
    def api_delete_preset(preset_id: int) -> dict[str, Any]:
        store.delete_preset(preset_id)
        return {"ok": True}

    @app.post("/api/preview")
    def api_preview(body: LaunchIn) -> dict[str, Any]:
        ws = store.get_workspace(body.workspace_id)
        if not ws:
            raise HTTPException(404, "工作区不存在")
        path = _safe_script(Path(ws["path"]), body.script)
        spec = parse_script(path)
        try:
            plans = preview_plans(
                ws,
                body.script,
                spec,
                body.values,
                extra=body.extra,
                overrides=body.overrides,
                override_dims=body.override_dims,
                python=body.python,
                gpu=body.gpu,
                gpu_policy=body.gpu_policy,
                sweep=body.sweep,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return {
            "plans": plans,
            "commands": [p["command"] for p in plans],
            "count": len(plans),
            "kind": spec.get("kind"),
            "max_concurrent": jobs.max_concurrent(),
        }

    @app.post("/api/jobs")
    def api_launch(body: LaunchIn) -> dict[str, Any]:
        ws = store.get_workspace(body.workspace_id)
        if not ws:
            raise HTTPException(404, "工作区不存在")
        path = _safe_script(Path(ws["path"]), body.script)
        spec = parse_script(path)
        try:
            created = jobs.enqueue(
                workspace=ws,
                script_rel=body.script,
                spec=spec,
                values=body.values,
                extra=body.extra,
                overrides=body.overrides,
                override_dims=body.override_dims,
                env=body.env,
                gpu=body.gpu,
                gpu_policy=body.gpu_policy,
                python=body.python,
                cwd=body.cwd,
                sweep=body.sweep,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"jobs": created, "count": len(created), "max_concurrent": jobs.max_concurrent()}

    @app.post("/api/jobs/batch-stop")
    def api_batch_stop(body: StopBatchIn) -> dict[str, Any]:
        if not body.ids and not body.group_id and not body.gpu and not body.status:
            raise HTTPException(400, "需要指定 ids / group_id / gpu / status")
        stopped = jobs.stop_matching(
            ids=body.ids,
            group_id=body.group_id,
            gpu=body.gpu,
            status=body.status,
        )
        return {"stopped": stopped, "count": len(stopped)}

    @app.get("/api/jobs")
    def api_jobs() -> dict[str, Any]:
        return {"jobs": attach_tails(store.list_jobs())}

    @app.get("/api/jobs/{job_id}")
    def api_job(job_id: str) -> dict[str, Any]:
        job = store.get_job(job_id)
        if not job:
            raise HTTPException(404, "任务不存在")
        return job

    @app.post("/api/jobs/{job_id}/stop")
    def api_stop(job_id: str) -> dict[str, Any]:
        job = jobs.stop(job_id)
        if not job:
            raise HTTPException(404, "任务不存在")
        return job

    @app.get("/api/jobs/{job_id}/log")
    def api_log(job_id: str, offset: int = 0) -> dict[str, Any]:
        job = store.get_job(job_id)
        if not job:
            raise HTTPException(404, "任务不存在")
        chunk = read_log(job["log_path"], offset=offset)
        chunk["status"] = job["status"]
        chunk["job"] = job
        return chunk

    @app.get("/api/jobs/{job_id}/stream")
    async def api_stream(job_id: str):
        job = store.get_job(job_id)
        if not job:
            raise HTTPException(404, "任务不存在")

        async def gen():
            import asyncio

            offset = 0
            while True:
                current = store.get_job(job_id)
                if not current:
                    break
                chunk = read_log(current["log_path"], offset=offset, limit=16_000)
                if chunk["text"]:
                    payload = json.dumps(
                        {"text": chunk["text"], "status": current["status"]},
                        ensure_ascii=False,
                    )
                    yield f"data: {payload}\n\n"
                    offset = chunk["offset"]
                if current["status"] not in {"queued", "running"} and chunk["eof"]:
                    yield f"data: {json.dumps({'done': True, 'status': current['status']})}\n\n"
                    break
                await asyncio.sleep(0.35)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    assets_dir = STATIC_DIR / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/favicon.svg")
    def favicon() -> FileResponse:
        icon = STATIC_DIR / "favicon.svg"
        if not icon.is_file():
            raise HTTPException(404, "favicon not found")
        return FileResponse(icon)

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    return app
