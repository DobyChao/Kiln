import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useKiln } from "../context/KilnContext";
import { Button, Empty, Field, Hint, PageHeader, Panel } from "../components/ui";

export default function Home() {
  const { toast } = useKiln();
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", path: "", python: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api("/workspaces")
      .then((data) => {
        if (!cancelled) setList(data.workspaces || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const ws = await api("/workspaces", {
        method: "POST",
        body: { name: form.name, path: form.path, python: form.python || null },
      });
      navigate(`/ws/${ws.id}`);
    } catch (err) {
      toast(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadExamples() {
    try {
      const ws = await api("/workspaces/examples", { method: "POST", body: {} });
      navigate(`/ws/${ws.id}`);
    } catch (err) {
      toast(err.message);
    }
  }

  if (error) return <Empty title="加载失败">{error}</Empty>;

  return (
    <>
      <PageHeader
        kicker="工作区"
        title="你的训练项目"
        lede="把仓库根目录加进来。Kiln 会列出 Python 脚本，把命令行参数变成表单，确认后再运行，不必手敲一长串 CLI。"
      />
      <Hint title="怎么用" defaultOpen>
        <ol>
          <li>
            填写下面的项目路径（Windows 如 <code>D:\research\cls</code>，Linux 如 <code>/data/exp</code>
            ），添加工作区。
          </li>
          <li>进入工作区后选一个脚本，填参数，看右侧命令预览，再点「运行」。</li>
          <li>到左侧「任务」查看排队、日志、tqdm 进度，并可随时停止。</li>
        </ol>
        <p className="mt-2">也可以先点「加载示例」走一遍流程。</p>
      </Hint>
      <Panel className="mb-5">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="名称">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如 ImageNet 消融"
            />
          </Field>
          <Field label="项目路径">
            <input
              required
              value={form.path}
              onChange={(e) => setForm({ ...form, path: e.target.value })}
              placeholder="训练仓库的根目录"
            />
          </Field>
          <Field label="Python（可选）">
            <input
              value={form.python}
              onChange={(e) => setForm({ ...form, python: e.target.value })}
              placeholder="留空则用当前解释器；conda 环境填 python 路径"
            />
          </Field>
          <div className="flex flex-wrap items-end gap-2 sm:col-span-2 xl:col-span-3">
            <Button variant="solid" type="submit" disabled={busy}>
              添加工作区
            </Button>
            <Button variant="ghost" onClick={loadExamples}>
              加载示例
            </Button>
          </div>
        </form>
      </Panel>
      {list === null ? (
        <p className="text-sm text-muted">加载中…</p>
      ) : list.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
          {list.map((w) => (
            <Link
              key={w.id}
              to={`/ws/${w.id}`}
              className="block rounded-xl border border-line bg-panel p-4 no-underline shadow-[0_1px_2px_rgba(0,0,0,.25)] transition hover:border-muted/40 hover:bg-hover"
            >
              <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">工作区</span>
              <div className="mt-2 break-all font-semibold">{w.name}</div>
              <div className="mt-1 break-all text-xs text-muted">{w.path}</div>
            </Link>
          ))}
        </div>
      ) : (
        <Empty title="还没有工作区">填一个训练项目的根目录，或先加载自带示例看效果。</Empty>
      )}
    </>
  );
}
