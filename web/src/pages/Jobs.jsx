import { Link } from "react-router-dom";
import { api } from "../api";
import { useKiln } from "../context/KilnContext";
import { adapterLabel, elapsed, hasCuda } from "../lib/format";
import { lastLines, renderTerminal } from "../lib/term";
import { Button, CommitNumber, Field, Hint, PageHeader, Panel, StatusBadge } from "../components/ui";

export default function Jobs() {
  const { gpu, jobs, settings, setSettings, toast, refresh } = useKiln();
  const cuda = hasCuda(gpu);
  const running = jobs.filter((j) => j.status === "running");
  const queued = jobs.filter((j) => j.status === "queued");
  const done = jobs.filter((j) => j.status !== "running" && j.status !== "queued");
  const gpus = gpu?.gpus || [];

  async function stopJob(id) {
    try {
      await api(`/jobs/${id}/stop`, { method: "POST", body: {} });
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  }

  async function stopGroup(groupId) {
    try {
      const data = await api("/jobs/batch-stop", { method: "POST", body: { group_id: groupId } });
      toast(`已停 ${data.count} 个`);
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  }

  async function stopGpu(index) {
    try {
      const data = await api("/jobs/batch-stop", { method: "POST", body: { gpu: String(index) } });
      toast(`GPU ${index} 已停 ${data.count} 个`);
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  }

  return (
    <>
      <PageHeader
        kicker="运行记录"
        title="任务"
        lede="这里能看到排队、正在跑、以及最近完成的进程。点进任务看 print / tqdm 日志。"
        actions={
          <>
            {cuda && (
              <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted">
                <input
                  type="checkbox"
                  className="w-auto"
                  checked={!!settings.gpu_exclusive}
                  onChange={async (e) => {
                    try {
                      const next = await api("/settings", {
                        method: "POST",
                        body: { gpu_exclusive: e.target.checked },
                      });
                      setSettings(next);
                    } catch (err) {
                      toast(err.message);
                    }
                  }}
                />
                同卡不叠
              </label>
            )}
            <Field label="同时运行" className="w-[140px]">
              <CommitNumber
                value={settings.max_concurrent}
                min={1}
                max={64}
                onCommit={async (n) => {
                  try {
                    const next = await api("/settings", {
                      method: "POST",
                      body: { max_concurrent: n },
                    });
                    setSettings(next);
                    toast("并发已更新");
                  } catch (err) {
                    toast(err.message);
                    throw err;
                  }
                }}
              />
            </Field>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  const data = await api("/jobs/batch-stop", { method: "POST", body: { status: "queued" } });
                  toast(`已取消排队 ${data.count} 个`);
                  await refresh();
                } catch (err) {
                  toast(err.message);
                }
              }}
            >
              清空排队
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                if (!confirm("停止所有正在运行的进程？")) return;
                try {
                  const data = await api("/jobs/batch-stop", { method: "POST", body: { status: "running" } });
                  toast(`已停 ${data.count} 个`);
                  await refresh();
                } catch (err) {
                  toast(err.message);
                }
              }}
            >
              停掉在跑
            </Button>
          </>
        }
      />
      <Hint>
        运行中的卡片会显示最近几行输出。点任务名称打开完整日志（进度条会在同一行刷新）。可停止单个、整组或全部在跑的进程。
      </Hint>
      {gpus.length ? (
        <div className="mb-5 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
          {gpus.map((g) => {
            const run = g.running || [];
            const q = g.queued || [];
            return (
              <div
                key={g.index}
                className={`rounded-xl border bg-panel p-3 text-[13px] ${run.length ? "border-ember/40" : "border-line"}`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <b>GPU {g.index}</b> <span className="text-muted">{g.name}</span>
                  </div>
                  {run.length ? (
                    <Button size="sm" variant="danger" onClick={() => stopGpu(g.index)}>
                      停此卡
                    </Button>
                  ) : null}
                </div>
                {run.length ? (
                  run.map((j) => (
                    <Link key={j.id} to={`/jobs/${j.id}`} className="block text-ember no-underline hover:underline">
                      {j.script || j.id} · pid {j.pid || "—"}
                    </Link>
                  ))
                ) : (
                  <div className="text-muted">空闲</div>
                )}
                {q.length ? <div className="text-muted">排队 {q.length}</div> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mb-4 rounded-xl border border-line bg-panel p-3 text-[13px]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <b>CPU 进程</b>
            <span className="text-muted">{adapterLabel(gpu) || "无 CUDA"}</span>
          </div>
          <div>
            运行中 {running.length} · 排队 {queued.length} · 同时最多 {settings.max_concurrent} 路
          </div>
        </div>
      )}
      <JobSection title="运行中" items={running} onStop={stopJob} onStopGroup={stopGroup} />
      <JobSection title="排队" items={queued} onStop={stopJob} onStopGroup={stopGroup} />
      {done.length ? (
        <JobSection title="最近完成" items={done.slice(0, 40)} onStop={stopJob} onStopGroup={stopGroup} />
      ) : null}
    </>
  );
}

function JobSection({ title, items, onStop, onStopGroup }) {
  return (
    <Panel className="mb-4">
      <h2 className="mb-3 text-[15px] font-semibold">
        {title} · {items.length}
      </h2>
      {items.length ? (
        <div className="flex flex-col gap-2">
          {items.map((j) => (
            <JobCard key={j.id} job={j} onStop={onStop} onStopGroup={onStopGroup} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">无</p>
      )}
    </Panel>
  );
}

function JobCard({ job: j, onStop, onStopGroup }) {
  const live = j.status === "running" || j.status === "queued";
  const dur =
    j.status === "running"
      ? elapsed(j.started_at)
      : j.started_at && j.finished_at
        ? elapsed(j.started_at, j.finished_at)
        : "";
  return (
    <div className="grid grid-cols-1 items-start gap-3 rounded-xl border border-line bg-bg/40 p-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
      <StatusBadge status={j.status} />
      <Link to={`/jobs/${j.id}`} className="min-w-0 text-inherit no-underline">
        <div className="flex flex-wrap items-baseline gap-2">
          <span>{j.script || ""}</span>
          {j.gpu != null && j.gpu !== "" ? <span className="text-xs text-muted">GPU {j.gpu}</span> : null}
          {dur ? <span className="text-xs text-muted">{dur}</span> : null}
        </div>
        <div className="truncate font-mono text-xs text-muted" title={j.command}>
          {j.command}
        </div>
        {j.tail ? (
          <pre className="mt-2 max-h-[5.6em] overflow-hidden rounded-lg border border-line bg-[#181511] px-2.5 py-2 font-mono text-[11px] break-all whitespace-pre-wrap text-muted">
            {lastLines(renderTerminal(j.tail), 4)}
          </pre>
        ) : null}
        <div className="mt-1 text-xs text-muted">
          {j.created_at || ""} · {j.id}
          {j.pid ? ` · pid ${j.pid}` : ""}
        </div>
      </Link>
      <div className="flex flex-wrap gap-2">
        {live ? (
          <Button size="sm" variant="danger" onClick={() => onStop(j.id)}>
            停止
          </Button>
        ) : null}
        {j.group_id && live ? (
          <Button size="sm" onClick={() => onStopGroup(j.group_id)}>
            停整组
          </Button>
        ) : null}
      </div>
    </div>
  );
}
