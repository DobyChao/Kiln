import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../api";
import { useKiln } from "../context/KilnContext";
import { adapterLabel, readWorkspaceNav } from "../lib/format";
import { CommitNumber, Field } from "./ui";

const SIDEBAR_KEY = "kiln-sidebar-w";
const SIDEBAR_DEFAULT = 240;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;

function clampSidebar(w) {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
}

function readSidebarWidth() {
  try {
    const n = Number(localStorage.getItem(SIDEBAR_KEY));
    if (Number.isFinite(n)) return clampSidebar(n);
  } catch {
    /* ignore */
  }
  return SIDEBAR_DEFAULT;
}

function GpuStrip({ gpu, jobs }) {
  const gpus = gpu?.gpus || [];
  if (!gpus.length) {
    const name = adapterLabel(gpu);
    const n = (jobs || []).filter((j) => j.status === "running").length;
    return (
      <div className="rounded-lg border border-line bg-panel px-2.5 py-2 text-[11px] text-muted">
        <b className="font-semibold text-text">CPU</b> {name || "无 NVIDIA / CUDA"}
        <div>{n ? `${n} 个进程在跑` : "无 CUDA 卡 · 进程仍可并发"}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {gpus.map((g) => {
        const mem = g.memory_total ? (g.memory_used / g.memory_total) * 100 : 0;
        const util = g.utilization || 0;
        const run = (g.running || [])[0];
        const qn = (g.queued || []).length;
        const line = run ? `在跑 ${run.script}` : qn ? `排队 ${qn}` : "空闲";
        return (
          <div
            key={g.index}
            className={`rounded-lg border px-2.5 py-2 text-[11px] text-muted ${
              run ? "border-ember/40 bg-ember-soft" : "border-line bg-panel"
            }`}
          >
            <b className="font-semibold text-text">GPU {g.index}</b> {String(g.name || "").slice(0, 16)}
            <div>
              {Math.round(g.memory_used)}/{Math.round(g.memory_total)}G · {Math.round(g.temperature)}°
            </div>
            <div className="truncate">{line}</div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-hover">
              <i className="block h-full bg-ember" style={{ width: `${Math.max(mem, util)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Sidebar({ onNavigate }) {
  const { gpu, jobs, settings, setSettings, toast } = useKiln();
  const location = useLocation();
  const [wsNav, setWsNav] = useState(readWorkspaceNav);
  const running = jobs.filter((j) => j.status === "running" || j.status === "queued").length;

  useEffect(() => {
    setWsNav(readWorkspaceNav());
  }, [location]);

  const linkClass = ({ isActive }) =>
    `flex items-center rounded-lg px-2.5 py-2 text-sm no-underline transition ${
      isActive ? "bg-hover font-semibold text-text" : "text-text hover:bg-hover"
    }`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-1.5">
      <Link to="/" onClick={onNavigate} className="flex flex-col gap-0.5 px-2.5 py-2 no-underline">
        <span className="text-xl font-semibold tracking-tight text-text">Kiln</span>
        <span className="text-xs text-muted">脚本启动台</span>
      </Link>
      <nav className="flex flex-col gap-0.5">
        <NavLink to="/" end className={linkClass} onClick={onNavigate}>
          工作区
        </NavLink>
        {wsNav && (
          <NavLink
            to={`/ws/${wsNav.id}`}
            className={({ isActive }) =>
              `rounded-lg py-1.5 pr-2.5 pl-5 text-[13px] no-underline ${
                isActive ? "bg-hover font-medium text-text" : "text-muted hover:bg-hover hover:text-text"
              }`
            }
            onClick={onNavigate}
          >
            {wsNav.name}
          </NavLink>
        )}
        <NavLink to="/jobs" className={linkClass} onClick={onNavigate}>
          <span className="flex w-full items-center justify-between gap-2">
            任务
            {running > 0 ? (
              <span className="rounded-full bg-ember-soft px-1.5 py-0.5 text-[11px] font-semibold text-ember">
                {running}
              </span>
            ) : null}
          </span>
        </NavLink>
      </nav>
      <div className="mt-4 rounded-lg bg-panel/60 px-3 py-2.5 text-xs leading-relaxed text-muted">
        <p>
          1. 添加项目目录
          <br />
          2. 选脚本填参数
          <br />
          3. 运行后在「任务」看日志
        </p>
      </div>
      <div className="mt-3 shrink-0">
        <Field label="同时最多几路">
          <CommitNumber
            value={settings.max_concurrent}
            min={1}
            max={64}
            onCommit={async (n) => {
              try {
                const next = await api("/settings", { method: "POST", body: { max_concurrent: n } });
                setSettings(next);
              } catch (err) {
                toast(err.message);
                throw err;
              }
            }}
          />
        </Field>
        <p className="mt-1 text-[10px] leading-snug text-muted">Kiln 全局上限，所有脚本共用。没选卡的任务只受这一条约束。</p>
      </div>
      <div className="mt-auto min-h-0 flex-1 overflow-y-auto overscroll-contain pt-3">
        <GpuStrip gpu={gpu} jobs={jobs} />
      </div>
    </div>
  );
}

export default function Layout() {
  const { toasts } = useKiln();
  const [open, setOpen] = useState(false);
  const [sidebarW, setSidebarW] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef({ active: false, startX: 0, startW: SIDEBAR_DEFAULT });
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarW));
    } catch {
      /* ignore */
    }
  }, [sidebarW]);

  function onResizePointerDown(e) {
    if (e.button !== 0) return;
    drag.current = { active: true, startX: e.clientX, startW: sidebarW };
    setResizing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onResizePointerMove(e) {
    if (!drag.current.active) return;
    setSidebarW(clampSidebar(drag.current.startW + (e.clientX - drag.current.startX)));
  }

  function onResizePointerUp() {
    if (!drag.current.active) return;
    drag.current.active = false;
    setResizing(false);
  }

  return (
    <div className={`flex h-dvh overflow-hidden bg-bg text-text ${resizing ? "select-none" : ""}`}>
      <div
        className="relative hidden min-h-0 shrink-0 md:flex"
        style={{ width: sidebarW }}
      >
        <aside className="flex h-full min-h-0 w-full flex-col overflow-hidden border-r border-line bg-sidebar px-3 py-4">
          <Sidebar />
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          aria-valuenow={sidebarW}
          tabIndex={0}
          className={`absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none ${
            resizing ? "bg-ember/40" : "bg-transparent hover:bg-ember/25"
          }`}
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          onDoubleClick={() => setSidebarW(SIDEBAR_DEFAULT)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              setSidebarW((w) => clampSidebar(w - 16));
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              setSidebarW((w) => clampSidebar(w + 16));
            }
          }}
        />
      </div>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label="关闭菜单"
            onClick={() => setOpen(false)}
          />
          <aside className="relative z-10 flex h-full w-64 min-h-0 flex-col overflow-hidden border-r border-line bg-sidebar px-3 py-4">
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 md:hidden">
          <button
            type="button"
            className="rounded-lg border border-line px-2.5 py-1 text-sm"
            onClick={() => setOpen(true)}
          >
            菜单
          </button>
          <span className="font-semibold">Kiln</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1180px] px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
            <Outlet />
          </div>
        </main>
      </div>

      <div className="pointer-events-none fixed right-5 bottom-5 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto min-w-52 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-sm shadow-lg"
          >
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
