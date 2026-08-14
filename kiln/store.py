from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._init()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init(self) -> None:
        with self._lock, self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS workspaces (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    path TEXT NOT NULL UNIQUE,
                    python TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS presets (
                    id INTEGER PRIMARY KEY,
                    workspace_id INTEGER NOT NULL,
                    script TEXT NOT NULL,
                    name TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    workspace_id INTEGER,
                    script TEXT,
                    command TEXT,
                    cwd TEXT,
                    payload TEXT,
                    status TEXT NOT NULL,
                    pid INTEGER,
                    return_code INTEGER,
                    log_path TEXT,
                    gpu TEXT,
                    group_id TEXT,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT
                );
                CREATE TABLE IF NOT EXISTS script_entries (
                    id INTEGER PRIMARY KEY,
                    workspace_id INTEGER NOT NULL,
                    path TEXT NOT NULL,
                    source TEXT NOT NULL,
                    hidden INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    UNIQUE(workspace_id, path),
                    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES ('max_concurrent', '8')"
            )
            existed = conn.execute(
                "SELECT 1 FROM settings WHERE key = 'gpu_exclusive'"
            ).fetchone()
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES ('gpu_exclusive', '1')"
            )
            if not existed:
                row = conn.execute(
                    "SELECT value FROM settings WHERE key = 'max_concurrent'"
                ).fetchone()
                if row and row["value"] == "1":
                    conn.execute(
                        "UPDATE settings SET value = '8' WHERE key = 'max_concurrent'"
                    )

    def setting(self, key: str, default: str | None = None) -> str | None:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = ?", (key,)
            ).fetchone()
            return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO settings(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    def list_workspaces(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM workspaces ORDER BY id DESC"
            ).fetchall()
            return [dict(r) for r in rows]

    def get_workspace(self, ws_id: int) -> dict[str, Any] | None:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM workspaces WHERE id = ?", (ws_id,)
            ).fetchone()
            return dict(row) if row else None

    def add_workspace(self, name: str, path: str, python: str | None) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO workspaces(name, path, python, created_at) VALUES (?, ?, ?, ?)",
                (name, path, python, _utc()),
            )
            row = conn.execute(
                "SELECT * FROM workspaces WHERE id = ?", (cur.lastrowid,)
            ).fetchone()
            return dict(row)

    def update_workspace(
        self, ws_id: int, name: str | None, python: str | None
    ) -> dict[str, Any] | None:
        ws = self.get_workspace(ws_id)
        if not ws:
            return None
        name = name if name is not None else ws["name"]
        python = python if python is not None else ws["python"]
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE workspaces SET name = ?, python = ? WHERE id = ?",
                (name, python, ws_id),
            )
        return self.get_workspace(ws_id)

    def delete_workspace(self, ws_id: int) -> None:
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM script_entries WHERE workspace_id = ?", (ws_id,))
            conn.execute("DELETE FROM presets WHERE workspace_id = ?", (ws_id,))
            conn.execute("DELETE FROM workspaces WHERE id = ?", (ws_id,))

    def list_script_entries(self, workspace_id: int) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM script_entries WHERE workspace_id = ? ORDER BY path",
                (workspace_id,),
            ).fetchall()
            return [dict(r) for r in rows]

    def sync_scanned(self, workspace_id: int, paths: list[str]) -> int:
        added = 0
        with self._lock, self._connect() as conn:
            for path in paths:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO script_entries"
                    "(workspace_id, path, source, hidden, created_at) VALUES (?, ?, 'scan', 0, ?)",
                    (workspace_id, path, _utc()),
                )
                added += cur.rowcount or 0
        return added

    def upsert_script(
        self, workspace_id: int, path: str, source: str = "manual", hidden: int = 0
    ) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            conn.execute(
                "INSERT INTO script_entries(workspace_id, path, source, hidden, created_at) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(workspace_id, path) DO UPDATE SET "
                "hidden = excluded.hidden, "
                "source = CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE script_entries.source END",
                (workspace_id, path, source, hidden, _utc()),
            )
            row = conn.execute(
                "SELECT * FROM script_entries WHERE workspace_id = ? AND path = ?",
                (workspace_id, path),
            ).fetchone()
            return dict(row)

    def set_script_hidden(self, workspace_id: int, path: str, hidden: bool) -> None:
        self.set_scripts_hidden(workspace_id, [path], hidden)

    def set_scripts_hidden(self, workspace_id: int, paths: list[str], hidden: bool) -> int:
        if not paths:
            return 0
        n = 0
        with self._lock, self._connect() as conn:
            for path in paths:
                cur = conn.execute(
                    "UPDATE script_entries SET hidden = ? WHERE workspace_id = ? AND path = ?",
                    (1 if hidden else 0, workspace_id, path),
                )
                n += cur.rowcount or 0
        return n

    def delete_script_entry(self, workspace_id: int, path: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                "DELETE FROM script_entries WHERE workspace_id = ? AND path = ?",
                (workspace_id, path),
            )

    def list_presets(self, workspace_id: int, script: str) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM presets WHERE workspace_id = ? AND script = ? ORDER BY id DESC",
                (workspace_id, script),
            ).fetchall()
            out = []
            for r in rows:
                item = dict(r)
                item["payload"] = json.loads(item["payload"])
                out.append(item)
            return out

    def add_preset(
        self, workspace_id: int, script: str, name: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO presets(workspace_id, script, name, payload, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (workspace_id, script, name, json.dumps(payload, ensure_ascii=False), _utc()),
            )
            row = conn.execute(
                "SELECT * FROM presets WHERE id = ?", (cur.lastrowid,)
            ).fetchone()
            item = dict(row)
            item["payload"] = json.loads(item["payload"])
            return item

    def delete_preset(self, preset_id: int) -> None:
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM presets WHERE id = ?", (preset_id,))

    def add_job(self, job: dict[str, Any]) -> dict[str, Any]:
        payload = job.get("payload")
        if isinstance(payload, dict):
            payload = json.dumps(payload, ensure_ascii=False)
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO jobs(
                    id, workspace_id, script, command, cwd, payload, status,
                    pid, return_code, log_path, gpu, group_id,
                    created_at, started_at, finished_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job["id"],
                    job.get("workspace_id"),
                    job.get("script"),
                    job.get("command"),
                    job.get("cwd"),
                    payload,
                    job.get("status", "queued"),
                    job.get("pid"),
                    job.get("return_code"),
                    job.get("log_path"),
                    job.get("gpu"),
                    job.get("group_id"),
                    job.get("created_at") or _utc(),
                    job.get("started_at"),
                    job.get("finished_at"),
                ),
            )
        return self.get_job(job["id"])  # type: ignore[return-value]

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                return None
            item = dict(row)
            if item.get("payload"):
                try:
                    item["payload"] = json.loads(item["payload"])
                except json.JSONDecodeError:
                    pass
            return item

    def list_jobs(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (limit,),
            ).fetchall()
            out = []
            for r in rows:
                item = dict(r)
                if item.get("payload"):
                    try:
                        item["payload"] = json.loads(item["payload"])
                    except json.JSONDecodeError:
                        pass
                out.append(item)
            return out

    def update_job(self, job_id: str, **fields: Any) -> None:
        if not fields:
            return
        cols = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [job_id]
        with self._lock, self._connect() as conn:
            conn.execute(f"UPDATE jobs SET {cols} WHERE id = ?", values)

    def mark_interrupted(self) -> int:
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "UPDATE jobs SET status = 'interrupted', finished_at = ? "
                "WHERE status IN ('queued', 'running')",
                (_utc(),),
            )
            return cur.rowcount
