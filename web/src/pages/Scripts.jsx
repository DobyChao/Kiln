import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useKiln } from "../context/KilnContext";
import { clearWorkspaceNav, rememberWorkspace } from "../lib/format";
import { Badge, Button, Empty, Field, Hint, PageHeader, Panel } from "../components/ui";

function isLaunchable(s) {
  return !!(s.launchable || s.has_main || s.has_argparse || s.has_hydra || s.has_fire || s.has_click);
}

export default function Scripts() {
  const { wsId } = useParams();
  const { toast } = useKiln();
  const navigate = useNavigate();
  const [showHidden, setShowHidden] = useState(() => sessionStorage.getItem("kiln-hidden") === "1");
  const [onlyLaunchable, setOnlyLaunchable] = useState(null);
  const [ws, setWs] = useState(null);
  const [scripts, setScripts] = useState([]);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [addPath, setAddPath] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    const data = await api(`/workspaces/${wsId}/scripts?hidden=${showHidden ? "true" : "false"}`);
    setWs(data.workspace);
    setScripts(data.scripts || []);
    rememberWorkspace(data.workspace.id, data.workspace.name);
  }, [wsId, showHidden]);

  useEffect(() => {
    let cancelled = false;
    load().catch((err) => {
      if (!cancelled) setError(err.message);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const launchableCount = useMemo(() => scripts.filter(isLaunchable).length, [scripts]);

  useEffect(() => {
    if (onlyLaunchable !== null) return;
    if (!scripts.length) return;
    setOnlyLaunchable(scripts.length > 24 && launchableCount > 0);
  }, [scripts, launchableCount, onlyLaunchable]);

  if (error) return <Empty title="加载失败">{error}</Empty>;
  if (!ws) return <p className="text-sm text-muted">加载中…</p>;

  const filtered = scripts.filter((s) => {
    if (q && !s.path.toLowerCase().includes(q.trim().toLowerCase())) return false;
    if (onlyLaunchable && !s.hidden && !isLaunchable(s)) return false;
    return true;
  });
  const clutter = scripts.filter((s) => !s.hidden && !isLaunchable(s));
  const visiblePaths = filtered.map((s) => s.path);
  const allVisibleSelected = visiblePaths.length > 0 && visiblePaths.every((p) => selected.has(p));

  function toggleSelect(path) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      if (allVisibleSelected) return new Set();
      return new Set(visiblePaths);
    });
  }

  async function rescan(mode) {
    setScanning(true);
    try {
      const res = await api(`/workspaces/${ws.id}/scripts/scan?hidden=${showHidden ? "true" : "false"}&mode=${mode}`, {
        method: "POST",
        body: {},
      });
      setScripts(res.scripts || []);
      setSelected(new Set());
      toast(mode === "launchable" ? `扫描完成，可启动 ${res.count} 个` : `扫描完成，列表 ${res.count} 个`);
    } catch (err) {
      toast(err.message);
    } finally {
      setScanning(false);
    }
  }

  async function addScript(e) {
    e.preventDefault();
    try {
      await api(`/workspaces/${ws.id}/scripts`, { method: "POST", body: { path: addPath } });
      toast("已添加到列表");
      setAddPath("");
      await load();
    } catch (err) {
      toast(err.message);
    }
  }

  async function hidePaths(paths, hidden) {
    if (!paths.length) return;
    try {
      const data = await api(`/workspaces/${ws.id}/scripts/hide`, {
        method: "POST",
        body: { paths, hidden },
      });
      toast(hidden ? `已从列表移除 ${data.count} 个` : `已恢复 ${data.count} 个`);
      setSelected(new Set());
      await load();
    } catch (err) {
      toast(err.message);
    }
  }

  async function delWs() {
    if (!confirm(`删除工作区 ${ws.name}？不会删除磁盘上的代码。`)) return;
    await api(`/workspaces/${ws.id}`, { method: "DELETE" });
    clearWorkspaceNav();
    navigate("/");
  }

  function toggleHidden() {
    const next = !showHidden;
    sessionStorage.setItem("kiln-hidden", next ? "1" : "0");
    setShowHidden(next);
    setSelected(new Set());
  }

  return (
    <>
      <PageHeader
        kicker={
          <>
            <Link to="/" className="text-muted underline-offset-2 hover:text-text hover:underline">
              工作区
            </Link>
            {" / "}
            {ws.name}
          </>
        }
        title={ws.name}
        lede={ws.path}
        actions={
          <>
            <Button size="sm" disabled={scanning} onClick={() => rescan("launchable")}>
              扫描可启动
            </Button>
            <Button size="sm" disabled={scanning} onClick={() => rescan("all")}>
              扫描全部 .py
            </Button>
            <Button size="sm" onClick={toggleHidden}>
              {showHidden ? "隐藏已移除" : "显示已移除"}
            </Button>
            <Button size="sm" variant="danger" onClick={delWs}>
              删除工作区
            </Button>
          </>
        }
      />
      <Hint>
        列表是「要跑的脚本」，不是仓库文件浏览器。第一次进入只自动收有 main / argparse / Hydra / Fire / Click
        的文件。漏掉的用「扫描全部」或手动添加；不需要的可勾选后批量移除（不删磁盘文件）。
      </Hint>
      <Panel className="mb-4">
        <form onSubmit={addScript} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="手动添加脚本" className="flex-1">
            <input
              required
              value={addPath}
              onChange={(e) => setAddPath(e.target.value)}
              placeholder="相对路径，如 train.py 或 tools/infer.py"
            />
          </Field>
          <Button variant="solid" type="submit">
            添加到列表
          </Button>
        </form>
      </Panel>

      {scripts.length > 0 && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <input
            className="max-w-80"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="过滤脚本路径…"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>
              {scripts.length} 个 · 可启动 {launchableCount}
            </span>
            <button
              type="button"
              className={`rounded-full border px-2.5 py-1 ${
                onlyLaunchable ? "border-ember/50 bg-ember-soft text-text" : "border-line hover:bg-hover"
              }`}
              onClick={() => setOnlyLaunchable(true)}
            >
              只看可启动
            </button>
            <button
              type="button"
              className={`rounded-full border px-2.5 py-1 ${
                onlyLaunchable === false ? "border-ember/50 bg-ember-soft text-text" : "border-line hover:bg-hover"
              }`}
              onClick={() => setOnlyLaunchable(false)}
            >
              全部
            </button>
          </div>
        </div>
      )}

      {scripts.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted">
            <input type="checkbox" className="w-auto" checked={allVisibleSelected} onChange={toggleSelectAll} />
            全选当前 {filtered.length} 个
          </label>
          {selected.size > 0 && (
            <>
              <Button size="sm" onClick={() => hidePaths([...selected], true)}>
                移除选中 · {selected.size}
              </Button>
              {showHidden && (
                <Button size="sm" onClick={() => hidePaths([...selected], false)}>
                  恢复选中
                </Button>
              )}
            </>
          )}
          {clutter.length > 0 && (
            <Button
              size="sm"
              onClick={() => {
                if (!confirm(`把 ${clutter.length} 个没有 CLI / main 的脚本移出列表？不会删除磁盘文件。`)) return;
                hidePaths(
                  clutter.map((s) => s.path),
                  true,
                );
              }}
            >
              隐藏不可启动 · {clutter.length}
            </Button>
          )}
        </div>
      )}

      {filtered.length ? (
        <div className="flex flex-col gap-1.5">
          {filtered.map((s) => {
            const badges = [];
            if (s.source === "manual") badges.push("手动");
            if (s.missing) badges.push("文件不存在");
            if (s.hidden) badges.push("已移除");
            if (s.has_main) badges.push("main");
            if (s.has_argparse) badges.push("argparse");
            if (s.has_hydra) badges.push("hydra");
            if (s.has_fire) badges.push("fire");
            if (s.has_click) badges.push("click");
            const runTo = `/ws/${ws.id}/run?script=${encodeURIComponent(s.path)}`;
            const blocked = s.hidden || s.missing;
            return (
              <div
                key={s.path}
                className={`flex flex-col gap-2 rounded-[10px] border border-line bg-panel px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between ${
                  s.hidden ? "opacity-55" : ""
                }`}
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <input
                    type="checkbox"
                    className="mt-1 w-auto shrink-0"
                    checked={selected.has(s.path)}
                    onChange={() => toggleSelect(s.path)}
                  />
                  <div className="min-w-0">
                    {blocked ? (
                      <span className="font-mono text-[13px] break-all">{s.path}</span>
                    ) : (
                      <Link to={runTo} className="font-mono text-[13px] break-all text-text no-underline hover:text-ember">
                        {s.path}
                      </Link>
                    )}
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                      {badges.map((b) => (
                        <Badge key={b}>{b}</Badge>
                      ))}
                      {s.lines ? <span>{s.lines} 行</span> : null}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2 pl-7 sm:pl-0">
                  {s.hidden ? (
                    <Button size="sm" onClick={() => hidePaths([s.path], false)}>
                      恢复
                    </Button>
                  ) : (
                    <>
                      <Link
                        to={runTo}
                        className="inline-flex items-center rounded-lg border border-ember bg-ember px-2.5 py-1 text-xs font-semibold text-white no-underline hover:brightness-110"
                      >
                        填参数
                      </Link>
                      <Button size="sm" onClick={() => hidePaths([s.path], true)}>
                        从列表移除
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : q ? (
        <Empty title={`没有匹配「${q.trim()}」的脚本`}>清空搜索框即可看到全部 {scripts.length} 个。</Empty>
      ) : onlyLaunchable && scripts.length ? (
        <Empty title="当前筛选下没有可启动脚本">
          点「全部」看其余 {scripts.length} 个，或「扫描全部 .py」。
        </Empty>
      ) : (
        <Empty title="列表是空的">
          <p className="mb-3">不会一进仓库就把所有 .py 扫进来。选一种方式开始：</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="solid" disabled={scanning} onClick={() => rescan("launchable")}>
              扫描可启动脚本
            </Button>
            <Button disabled={scanning} onClick={() => rescan("all")}>
              扫描全部 .py
            </Button>
          </div>
        </Empty>
      )}
    </>
  );
}
