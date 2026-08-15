import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useKiln } from "../context/KilnContext";
import { adapterLabel, hasCuda, rememberWorkspace } from "../lib/format";
import { Button, Empty, Field, Hint, PageHeader, Panel, Toggle } from "../components/ui";

function isNargsList(arg) {
  const n = arg?.nargs;
  if (n === "+" || n === "*") return true;
  if (typeof n === "number" && n > 1) return true;
  return Array.isArray(arg?.default);
}

function formatNargs(val) {
  if (Array.isArray(val)) return val.map((x) => (Array.isArray(x) ? formatNargs(x) : String(x))).join(" ");
  if (val == null) return "";
  return String(val);
}

function parseNargsInput(arg, raw) {
  return String(raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => coerceArg(arg, s));
}

function coerceArg(arg, raw) {
  if (!arg) return raw;
  if (arg.type === "int" && raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  if (arg.type === "float" && raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  if (arg.type === "bool") return isTruthy(raw);
  return raw;
}

function defaultValue(arg) {
  if (isNargsList(arg)) {
    if (Array.isArray(arg.default)) return arg.default.join(" ");
    if (arg.default !== undefined && arg.default !== null) return String(arg.default);
    return "";
  }
  if (arg.default !== undefined && arg.default !== null) return arg.default;
  if (arg.action === "store_true") return false;
  if (arg.action === "store_false") return true;
  return "";
}

function formatDefault(arg) {
  if (arg.default === undefined || arg.default === null) return "";
  if (Array.isArray(arg.default)) return arg.default.join(" ");
  return String(arg.default);
}

function choiceList(arg) {
  return (arg.choices || []).map((c) => String(c));
}

function preferLocalDevice(arg, value, cuda) {
  if (cuda) return value;
  const choices = choiceList(arg).map((c) => c.toLowerCase());
  if (!choices.includes("cpu")) return value;
  const cur = String(value ?? "").toLowerCase();
  if (cur !== "cuda" && cur !== "gpu") return value;
  const cpu = (arg.choices || []).find((c) => String(c).toLowerCase() === "cpu");
  return cpu !== undefined ? cpu : "cpu";
}

function isTruthy(v) {
  return v === true || v === "true" || v === "1" || v === 1;
}

function collectPayload(wsId, script, state, spec) {
  const byDest = Object.fromEntries((spec?.args || []).map((a) => [a.dest, a]));
  const values = {};
  let sweep = false;
  for (const [k, arr] of Object.entries(state.values)) {
    const arg = byDest[k];
    const clean = arr.map((v) => (v === "" ? null : v)).filter((v) => v !== null && v !== undefined);
    if (!clean.length) continue;
    if (isNargsList(arg)) {
      const lists = clean.map((v) => (Array.isArray(v) ? v : parseNargsInput(arg, v)));
      values[k] = lists;
      if (lists.length > 1) sweep = true;
    } else if (clean.length > 1) {
      values[k] = clean;
      sweep = true;
    } else values[k] = clean[0];
  }
  const override_dims = {};
  for (const row of state.overrideRows) {
    if (!row.key.trim()) continue;
    const vals = row.vals.map((v) => v.trim()).filter(Boolean);
    if (!vals.length) continue;
    if (vals.length > 1) {
      override_dims[row.key.trim()] = vals;
      sweep = true;
    } else override_dims[row.key.trim()] = vals[0];
  }
  const env = {};
  for (const row of state.envRows) {
    if (row.key.trim()) env[row.key.trim()] = row.value;
  }
  return {
    workspace_id: Number(wsId),
    script,
    values,
    extra: state.extra,
    overrides: [],
    override_dims,
    env,
    gpu: (state.gpus || []).join(",") || null,
    gpu_policy: state.gpuPolicy || "pin",
    python: state.python || null,
    cwd: state.cwd || null,
    sweep,
  };
}

export default function Launch() {
  const { wsId } = useParams();
  const [params] = useSearchParams();
  const script = params.get("script");
  const navigate = useNavigate();
  const { gpu, settings, setSettings, toast } = useKiln();
  const [error, setError] = useState("");
  const [cliText, setCliText] = useState("");
  const [ready, setReady] = useState(null);
  const [L, setL] = useState(null);
  const [preview, setPreview] = useState({ text: "预览命令…", hint: "", count: 1 });

  const cuda = hasCuda(gpu);
  const specRef = useRef(null);
  specRef.current = ready?.spec;

  useEffect(() => {
    if (!script) return;
    let cancelled = false;
    (async () => {
      try {
        const [spec, presets, interpreters, wsPack, gpuInfo] = await Promise.all([
          api(`/workspaces/${wsId}/parse?script=${encodeURIComponent(script)}`),
          api(`/presets?workspace_id=${wsId}&script=${encodeURIComponent(script)}`),
          api("/interpreters"),
          api(`/workspaces/${wsId}/scripts`),
          api("/gpu"),
        ]);
        if (cancelled) return;
        const ws = wsPack.workspace;
        rememberWorkspace(ws.id, ws.name);
        const values = {};
        const adjusted = [];
        const cudaNow = hasCuda(gpuInfo);
        for (const arg of spec.args || []) {
          const raw = defaultValue(arg);
          const next = preferLocalDevice(arg, raw, cudaNow);
          values[arg.dest] = [next];
          if (String(next) !== String(raw)) adjusted.push(arg.dest);
        }
        setReady({ spec, ws, interpreters: interpreters.interpreters || [] });
        setL({
          values,
          extra: "",
          overrideRows: spec.kind === "hydra" ? [{ key: "", vals: [""] }] : [],
          envRows: [{ key: "", value: "" }],
          gpus: [],
          gpuPolicy: "spread",
          python: ws.python || "",
          cwd: "",
          presets: presets.presets || [],
          adjusted,
        });
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wsId, script]);

  const runPreview = useCallback(async (state, notify) => {
    const payload = collectPayload(wsId, script, state, specRef.current);
    try {
      const data = await api("/preview", { method: "POST", body: payload });
      const plans = data.plans || (data.commands || []).map((command) => ({ command, gpu: null }));
      const text =
        plans
          .slice(0, 8)
          .map((p) => (p.gpu != null && p.gpu !== "" ? `[GPU ${p.gpu}] ${p.command}` : p.command))
          .join("\n\n") + (plans.length > 8 ? `\n\n… 共 ${plans.length} 条` : "");
      const gpus = [...new Set(plans.map((p) => p.gpu).filter((g) => g != null && g !== ""))];
      const bits = [];
      bits.push(payload.sweep ? `消融 ${data.count} 组` : "单次运行");
      if (gpus.length) {
        bits.push(
          payload.gpu_policy === "spread" ? `轮转到 GPU ${gpus.join(",")}` : `CUDA_VISIBLE_DEVICES=${gpus.join(" / ")}`,
        );
      }
      bits.push(`同时最多 ${data.max_concurrent || settings.max_concurrent} 路`);
      setPreview({ text, hint: bits.join(" · "), count: data.count });
      if (notify) toast("已更新预览");
    } catch (err) {
      setPreview({ text: err.message, hint: "", count: 1 });
      if (notify) toast(err.message);
    }
  }, [settings.max_concurrent, toast, wsId, script]);

  const previewKey = L
    ? JSON.stringify({
        values: L.values,
        extra: L.extra,
        overrideRows: L.overrideRows,
        gpus: L.gpus,
        gpuPolicy: L.gpuPolicy,
        python: L.python,
      })
    : "";
  const launchRef = useRef(L);
  launchRef.current = L;

  useEffect(() => {
    if (!launchRef.current) return;
    const t = setTimeout(() => runPreview(launchRef.current, false), 280);
    return () => clearTimeout(t);
  }, [previewKey, runPreview]);

  function coerce(dest, raw) {
    const arg = (ready?.spec.args || []).find((a) => a.dest === dest);
    if (isNargsList(arg)) return raw;
    return coerceArg(arg, raw);
  }

  function patch(fn) {
    setL((prev) => (prev ? fn({ ...prev }) : prev));
  }

  async function doLaunch() {
    const payload = collectPayload(wsId, script, L, ready.spec);
    const missing = (ready.spec.args || []).filter((arg) => {
      if (!arg.required) return false;
      const v = payload.values[arg.dest];
      if (isNargsList(arg)) {
        const items = Array.isArray(v) ? v.flat() : [];
        return !items.length;
      }
      return v === undefined || v === null || v === "";
    });
    if (missing.length) {
      toast(`缺少必填参数 ${missing.map((a) => a.name).join(", ")}`);
      return;
    }
    try {
      const data = await api("/jobs", { method: "POST", body: payload });
      toast(`已提交 ${data.count} 个任务${data.max_concurrent ? ` · 同时 ${data.max_concurrent} 路` : ""}`);
      navigate("/jobs");
    } catch (err) {
      toast(err.message);
    }
  }

  async function savePreset() {
    const name = (L.presetName || "").trim();
    if (!name) {
      toast("先填一个预设名称");
      return;
    }
    const payload = collectPayload(wsId, script, L, ready.spec);
    try {
      await api("/presets", {
        method: "POST",
        body: { workspace_id: Number(wsId), script, name, payload },
      });
      toast("已保存预设");
      const data = await api(`/presets?workspace_id=${wsId}&script=${encodeURIComponent(script)}`);
      patch((prev) => ({ ...prev, presets: data.presets || [], presetName: "" }));
    } catch (err) {
      toast(err.message);
    }
  }

  function valueSlots(arg, v) {
    if (v === undefined) return [defaultValue(arg)];
    if (isNargsList(arg)) {
      if (Array.isArray(v) && v.length && Array.isArray(v[0])) return v.map(formatNargs);
      return [formatNargs(v)];
    }
    return Array.isArray(v) ? v : [v];
  }

  function applyPreset(id) {
    const preset = L.presets.find((p) => p.id === id);
    if (!preset) return;
    const p = preset.payload || {};
    const values = {};
    for (const arg of ready.spec.args || []) {
      values[arg.dest] = valueSlots(arg, p.values?.[arg.dest]);
    }
    let overrideRows = Object.entries(p.override_dims || {}).map(([key, val]) => ({
      key,
      vals: Array.isArray(val) ? val : [val],
    }));
    if (!overrideRows.length && ready.spec.kind === "hydra") overrideRows = [{ key: "", vals: [""] }];
    let envRows = Object.entries(p.env || {}).map(([key, value]) => ({ key, value }));
    if (!envRows.length) envRows = [{ key: "", value: "" }];
    patch((prev) => ({
      ...prev,
      values,
      extra: p.extra || "",
      python: p.python || prev.python,
      gpus: String(p.gpu || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      gpuPolicy: p.gpu_policy || ((p.gpu || "").includes(",") ? "spread" : "pin"),
      cwd: p.cwd || "",
      overrideRows,
      envRows,
      adjusted: [],
    }));
    toast(`已套用 ${preset.name}`);
  }

  async function deletePreset(id, name) {
    if (!confirm(`删除预设「${name}」？`)) return;
    try {
      await api(`/presets/${id}`, { method: "DELETE" });
      const data = await api(`/presets?workspace_id=${wsId}&script=${encodeURIComponent(script)}`);
      patch((prev) => ({ ...prev, presets: data.presets || [] }));
      toast("已删除预设");
    } catch (err) {
      toast(err.message);
    }
  }

  async function applyCli() {
    const command = cliText.trim();
    if (!command) {
      toast("先粘贴一条命令");
      return;
    }
    try {
      const data = await api("/parse-cli", {
        method: "POST",
        body: { workspace_id: Number(wsId), script, command },
      });
      const values = { ...L.values };
      for (const arg of ready.spec.args || []) {
        if (data.values && Object.prototype.hasOwnProperty.call(data.values, arg.dest)) {
          values[arg.dest] = valueSlots(arg, data.values[arg.dest]);
        }
      }
      let overrideRows = L.overrideRows;
      if (data.override_dims && Object.keys(data.override_dims).length) {
        overrideRows = Object.entries(data.override_dims).map(([key, val]) => ({
          key,
          vals: Array.isArray(val) ? val : [val],
        }));
      }
      patch((prev) => ({
        ...prev,
        values,
        extra: data.extra || prev.extra,
        overrideRows,
        adjusted: [],
      }));
      const n = Object.keys(data.values || {}).length;
      toast(n ? `已填入 ${n} 个参数` : "没有识别到已知参数，已放进额外参数");
    } catch (err) {
      toast(err.message);
    }
  }

  const pythonOptions = useMemo(() => {
    if (!ready || !L) return [];
    const seen = new Set();
    const opts = [];
    const add = (path, label) => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      opts.push({ path, label });
    };
    for (const it of ready.interpreters) add(it.path, `${it.label} — ${it.path}`);
    if (L.python && !seen.has(L.python)) add(L.python, L.python);
    if (!opts.length) opts.push({ path: "", label: "默认" });
    return opts;
  }, [ready, L]);

  if (!script) return <Empty title="未指定脚本" />;
  if (error) return <Empty title="加载失败">{error}</Empty>;
  if (!ready || !L) return <p className="text-sm text-muted">加载中…</p>;

  const spec = ready.spec;
  const args = spec.args || [];

  return (
    <>
      <PageHeader
        kicker={
          <>
            <Link to={`/ws/${wsId}`} className="text-muted underline-offset-2 hover:text-text hover:underline">
              脚本列表
            </Link>
            {` · ${spec.kind || "raw"} · ${ready.ws.name}`}
          </>
        }
        title={script}
        lede={spec.description || spec.error || "把命令行参数填进表单。确认右侧预览后再运行。"}
        actions={
          <Link
            to={`/ws/${wsId}`}
            className="inline-flex items-center rounded-lg border border-line px-3 py-1.5 text-sm no-underline hover:bg-hover"
          >
            ← 返回脚本列表
          </Link>
        }
      />
      <Hint>
        左侧是参数。nargs=+ 的框用空格填写多个值（如 1 2 3 4，逗号也可以）。「+ 多值」是消融，会变成多条任务。可把一整条命令粘贴到预设里解析进表单。
      </Hint>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
        <div className="min-w-0 space-y-4">
          <Panel>
            <h2 className="mb-3 text-[15px] font-semibold">预设</h2>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {L.presets.map((p) => (
                <span key={p.id} className="inline-flex overflow-hidden rounded-lg border border-line">
                  <button
                    type="button"
                    className="px-2.5 py-1 text-xs hover:bg-hover"
                    onClick={() => applyPreset(p.id)}
                  >
                    {p.name}
                  </button>
                  <button
                    type="button"
                    className="border-l border-line px-1.5 text-xs text-muted hover:bg-bad-soft hover:text-bad"
                    title={`删除 ${p.name}`}
                    onClick={() => deletePreset(p.id, p.name)}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                className="max-w-40"
                placeholder="预设名称"
                value={L.presetName || ""}
                onChange={(e) => patch((prev) => ({ ...prev, presetName: e.target.value }))}
              />
              <Button size="sm" onClick={savePreset}>
                保存当前
              </Button>
            </div>
            <Field label="从命令行填入当前表单">
              <textarea
                value={cliText}
                onChange={(e) => setCliText(e.target.value)}
                placeholder="python train.py --aa 1 2 3 4 --lr 1e-4"
              />
            </Field>
            <Button size="sm" className="mt-2" onClick={applyCli}>
              解析并填入
            </Button>
          </Panel>
          <Panel>
            <h2 className="mb-3 text-[15px] font-semibold">参数</h2>
            {args.length ? (
              <div>
                {args.map((arg) => (
                  <ArgRow
                    key={arg.dest}
                    arg={arg}
                    vals={L.values[arg.dest] ?? [defaultValue(arg)]}
                    tweaked={(L.adjusted || []).includes(arg.dest)}
                    onChange={(vals) =>
                      patch((prev) => ({
                        ...prev,
                        values: {
                          ...prev.values,
                          [arg.dest]: vals.map((v) => (typeof v === "number" || typeof v === "boolean" ? v : coerce(arg.dest, v))),
                        },
                      }))
                    }
                    onSweep={() =>
                      patch((prev) => {
                        const cur = prev.values[arg.dest] || [""];
                        return {
                          ...prev,
                          values: { ...prev.values, [arg.dest]: [...cur, defaultValue(arg)] },
                        };
                      })
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">没有解析到参数，用下方「额外命令行参数」直接写。</p>
            )}
            {spec.kind === "hydra" && (
              <div className="mt-4">
                <div className="mb-2 text-xs text-muted">Hydra 覆盖项 · 一行一个键，值可多个做消融</div>
                <OverrideRows
                  rows={L.overrideRows}
                  onChange={(overrideRows) => patch((prev) => ({ ...prev, overrideRows }))}
                />
                <Button
                  size="sm"
                  className="mt-1"
                  onClick={() => patch((prev) => ({ ...prev, overrideRows: [...prev.overrideRows, { key: "", vals: [""] }] }))}
                >
                  + 覆盖项
                </Button>
              </div>
            )}
          </Panel>
          <Panel>
            <h2 className="mb-3 text-[15px] font-semibold">额外参数 / 环境变量</h2>
            <Field label="额外命令行参数">
              <textarea
                value={L.extra}
                onChange={(e) => patch((prev) => ({ ...prev, extra: e.target.value }))}
                placeholder="解析不到的参数写这里，例如 --local_rank 0"
              />
            </Field>
            <div className="mt-3 space-y-2">
              {L.envRows.map((row, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <input
                    placeholder="变量名"
                    value={row.key}
                    onChange={(e) =>
                      patch((prev) => {
                        const envRows = prev.envRows.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r));
                        return { ...prev, envRows };
                      })
                    }
                  />
                  <input
                    placeholder="值"
                    value={row.value}
                    onChange={(e) =>
                      patch((prev) => {
                        const envRows = prev.envRows.map((r, idx) => (idx === i ? { ...r, value: e.target.value } : r));
                        return { ...prev, envRows };
                      })
                    }
                  />
                  <Button
                    size="sm"
                    onClick={() =>
                      patch((prev) => {
                        const envRows = prev.envRows.filter((_, idx) => idx !== i);
                        return { ...prev, envRows: envRows.length ? envRows : [{ key: "", value: "" }] };
                      })
                    }
                  >
                    删
                  </Button>
                </div>
              ))}
            </div>
            <Button
              size="sm"
              className="mt-2"
              onClick={() => patch((prev) => ({ ...prev, envRows: [...prev.envRows, { key: "", value: "" }] }))}
            >
              + 环境变量
            </Button>
          </Panel>
        </div>

        <div className="min-w-0 xl:sticky xl:top-4">
          <Panel>
            <div className="mb-2.5 text-[13px] font-semibold text-muted">运行配置</div>
            <p className="mb-2.5 text-sm">
              <Link to={`/ws/${wsId}`} className="text-ember no-underline hover:underline">
                ← 返回脚本列表
              </Link>
            </p>
            <Field label="设备" />
            <GpuPick
              gpu={gpu}
              selected={L.gpus}
              onChange={(gpus) => patch((prev) => ({ ...prev, gpus }))}
            />
            {cuda && (
              <>
                <div className="mb-2 flex flex-col gap-1 text-[13px] text-muted">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="gpol"
                      checked={L.gpuPolicy === "spread"}
                      onChange={() => patch((prev) => ({ ...prev, gpuPolicy: "spread" }))}
                      className="w-auto"
                    />
                    每卡一进程，轮转分配
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="radio"
                      name="gpol"
                      checked={L.gpuPolicy === "pin"}
                      onChange={() => patch((prev) => ({ ...prev, gpuPolicy: "pin" }))}
                      className="w-auto"
                    />
                    每个进程都能看见所选卡（DDP）
                  </label>
                </div>
                <label className="mb-2 flex cursor-pointer items-center gap-2 text-[13px] text-muted">
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
                        toast(e.target.checked ? "同卡不叠" : "允许同卡叠任务");
                      } catch (err) {
                        toast(err.message);
                      }
                    }}
                  />
                  同卡不叠 Kiln 任务
                </label>
              </>
            )}
            <Field label="同时跑几路" className="mt-2.5">
              <input
                type="number"
                min={1}
                max={64}
                value={settings.max_concurrent}
                onChange={async (e) => {
                  try {
                    const next = await api("/settings", {
                      method: "POST",
                      body: { max_concurrent: Number(e.target.value) },
                    });
                    setSettings(next);
                  } catch (err) {
                    toast(err.message);
                  }
                }}
              />
            </Field>
            {!cuda && <p className="mt-1 text-xs text-muted">没有 GPU 时建议 1–2 路，避免把 CPU 打满。</p>}
            <Field label="Python" className="mt-2.5">
              <select value={L.python} onChange={(e) => patch((prev) => ({ ...prev, python: e.target.value }))}>
                {pythonOptions.map((o) => (
                  <option key={o.path || "default"} value={o.path}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="工作目录" className="mt-2.5">
              <input
                value={L.cwd}
                onChange={(e) => patch((prev) => ({ ...prev, cwd: e.target.value }))}
                placeholder="默认：脚本所在目录"
              />
            </Field>
            {preview.hint && <p className="mt-3 mb-2 text-xs text-muted">{preview.hint}</p>}
            <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-[#181511] p-3 font-mono text-xs break-all whitespace-pre-wrap text-muted">
              {preview.text}
            </pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => runPreview(L, true)}>预览</Button>
              <Button variant="solid" onClick={doLaunch}>
                {preview.count > 1 ? `运行 × ${preview.count}` : "运行"}
              </Button>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

function ArgRow({ arg, vals, tweaked, onChange, onSweep }) {
  const req = arg.required;
  const boolLike = arg.type === "bool" || arg.action === "store_true" || arg.action === "store_false";
  const singleChoice = arg.choices && arg.choices.length && vals.length <= 1;

  return (
    <div className="min-w-0 border-b border-line py-3 last:border-b-0">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="min-w-0 font-mono text-[13px] break-all">
          {arg.name} {req ? <span className="text-bad">*</span> : null}
        </span>
        <span className="min-w-0 max-w-[45%] text-right text-xs break-all text-muted">
          {arg.type || ""}
          {arg.nargs ? ` · nargs=${arg.nargs}` : ""}
          {arg.default !== undefined && arg.default !== null ? ` · 默认 ${formatDefault(arg)}` : ""}
        </span>
      </div>
      {arg.help ? <div className="mt-1 min-w-0 text-xs break-all text-muted">{arg.help}</div> : null}
      {isNargsList(arg) ? (
        <div className="mt-1 text-xs text-muted">空格分隔多个值，对应 --flag 1 2 3 4；逗号也会当成分隔符。点「+ 多值」才是消融成多条任务。</div>
      ) : null}
      {tweaked ? (
        <div className="mt-1 min-w-0 text-xs break-all text-muted">
          本机没有 CUDA，已从默认 {String(arg.default)} 改为 {String(vals[0])}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {boolLike ? (
          <>
            <Toggle on={isTruthy(vals[0])} onClick={() => onChange([!isTruthy(vals[0])])} />
            <span className="text-xs text-muted">{isTruthy(vals[0]) ? "true" : "false"}</span>
          </>
        ) : singleChoice ? (
          <>
            <select className="flex-1" value={vals[0]} onChange={(e) => onChange([e.target.value])}>
              {arg.choices.map((c) => (
                <option key={String(c)} value={c}>
                  {String(c)}
                </option>
              ))}
            </select>
            <Button size="sm" title="添加一组值，生成消融任务" onClick={onSweep}>
              + 多值
            </Button>
          </>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
              {vals.map((v, i) => (
                <span
                  key={i}
                  className={`flex min-w-0 items-center gap-1 rounded-lg border border-line bg-hover p-0.5 ${
                    vals.length === 1 ? "w-full" : "min-w-[12rem] flex-1 basis-[12rem]"
                  }`}
                >
                  <input
                    className="min-w-0 flex-1 border-0 bg-transparent py-1 pr-2 pl-2"
                    value={Array.isArray(v) ? formatNargs(v) : v}
                    placeholder={isNargsList(arg) ? "1 2 3 4" : undefined}
                    onChange={(e) => {
                      const next = [...vals];
                      next[i] = e.target.value;
                      onChange(next);
                    }}
                  />
                  {vals.length > 1 && (
                    <button
                      type="button"
                      className="shrink-0 px-1.5 text-muted"
                      onClick={() => {
                        const next = vals.filter((_, idx) => idx !== i);
                        onChange(next.length ? next : [""]);
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
            <Button size="sm" title="添加一组值，生成消融任务" onClick={onSweep}>
              + 多值
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function OverrideRows({ rows, onChange }) {
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1.4fr_auto]">
          <input
            placeholder="model.lr"
            value={row.key}
            onChange={(e) => onChange(rows.map((r, idx) => (idx === i ? { ...r, key: e.target.value } : r)))}
          />
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {row.vals.map((v, j) => (
              <span
                key={j}
                className={`flex min-w-0 items-center gap-1 rounded-lg border border-line bg-hover p-0.5 ${
                  row.vals.length === 1 ? "min-w-0 flex-1" : "min-w-[8rem] flex-1 basis-[8rem]"
                }`}
              >
                <input
                  className="min-w-0 flex-1 border-0 bg-transparent py-1 pr-2 pl-2"
                  value={v}
                  onChange={(e) =>
                    onChange(
                      rows.map((r, idx) =>
                        idx === i
                          ? { ...r, vals: r.vals.map((x, k) => (k === j ? e.target.value : x)) }
                          : r,
                      ),
                    )
                  }
                />
                {row.vals.length > 1 && (
                  <button
                    type="button"
                    className="px-1.5 text-muted"
                    onClick={() =>
                      onChange(
                        rows.map((r, idx) => {
                          if (idx !== i) return r;
                          const vals = r.vals.filter((_, k) => k !== j);
                          return { ...r, vals: vals.length ? vals : [""] };
                        }),
                      )
                    }
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            <Button
              size="sm"
              onClick={() => onChange(rows.map((r, idx) => (idx === i ? { ...r, vals: [...r.vals, ""] } : r)))}
            >
              +
            </Button>
          </div>
          <Button size="sm" onClick={() => onChange(rows.filter((_, idx) => idx !== i))}>
            删
          </Button>
        </div>
      ))}
    </div>
  );
}

function GpuPick({ gpu, selected, onChange }) {
  const gpus = gpu?.gpus || [];
  if (!gpus.length) {
    const name = adapterLabel(gpu);
    return (
      <div className="my-2 text-sm text-muted">
        <p>
          这台机器没有 NVIDIA GPU{name ? `（${name}）` : ""}。任务会按「同时跑几路」做普通进程并发。在 Linux
          训练机上启动 Kiln 时，这里会列出 CUDA 卡。
        </p>
        <details className="mt-2">
          <summary className="cursor-pointer">仍要手写 CUDA_VISIBLE_DEVICES</summary>
          <input
            className="mt-2"
            placeholder="例如 0 或 0,1"
            value={(selected || []).join(",")}
            onChange={(e) =>
              onChange(
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
        </details>
      </div>
    );
  }
  return (
    <div className="my-2 flex flex-col gap-1.5">
      {gpus.map((g) => {
        const id = String(g.index);
        const on = (selected || []).includes(id);
        const run = (g.running || [])[0];
        return (
          <label
            key={id}
            className={`grid cursor-pointer grid-cols-[auto_1fr] items-start gap-2 rounded-lg border px-2.5 py-2 text-[13px] ${
              on ? "border-ember/40 bg-ember-soft" : "border-line bg-[#181511]"
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 w-auto"
              checked={on}
              onChange={(e) => {
                if (e.target.checked) onChange([...new Set([...(selected || []), id])]);
                else onChange((selected || []).filter((x) => x !== id));
              }}
            />
            <span>
              <b>{id}</b> {g.name}
              <span className="text-muted">
                {" "}
                {run ? `占用 ${run.script}` : "空闲"} · {Math.round(g.memory_used)}/{Math.round(g.memory_total)}G
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
