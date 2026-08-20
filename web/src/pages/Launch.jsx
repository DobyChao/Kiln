import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useKiln } from "../context/KilnContext";
import { adapterLabel, hasCuda, readLaunchDraft, rememberWorkspace, writeLaunchDraft } from "../lib/format";
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

/** True when Number(s) would accept the text but collapsing to a number would fight typing. */
function isNumericDraft(raw) {
  const s = String(raw ?? "");
  const t = s.trim();
  if (!t || t === "+" || t === "-" || t === "." || t === "+." || t === "-.") return true;
  // "1." / "1.0" / "1e-" — Number() parses these but String(Number()) loses the draft.
  if (/[eE][+-]?$/.test(t)) return true;
  if (/^[+-]?\d+\.$/.test(t)) return true;
  const n = Number(t);
  if (Number.isNaN(n)) return true;
  return String(n) !== t;
}

function coerceArg(arg, raw) {
  if (!arg) return raw;
  if (arg.type === "int" || arg.type === "float") {
    if (raw === "" || raw == null) return raw;
    if (typeof raw === "number") return raw;
    if (isNumericDraft(raw)) return typeof raw === "string" ? raw : String(raw);
    const n = Number(String(raw).trim());
    if (arg.type === "int" && !Number.isInteger(n)) return String(raw);
    return n;
  }
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

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Mirrors kiln/jobs.py _token: keep swept values safe inside a path segment. */
function tokenize(value) {
  const text = String(value ?? "").trim();
  return text.replace(/[<>:"/\\|?*\s]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "na";
}

function renderTemplate(template, ctx, index, total) {
  const width = String(total).length;
  return String(template ?? "").replace(PLACEHOLDER, (whole, key) => {
    if (key === "i") return String(index).padStart(width, "0");
    if (key === "n") return String(total);
    if (Object.prototype.hasOwnProperty.call(ctx, key)) return tokenize(ctx[key]);
    return whole;
  });
}

const ARTIFACT = new Set([
  "out", "output", "outputs", "outdir", "save", "savedir", "ckpt", "ckpts", "checkpoint",
  "checkpoints", "log", "logs", "logdir", "result", "results", "exp", "run", "workdir", "name",
]);
const NOT_ARTIFACT = new Set([
  "data", "input", "inputs", "load", "resume", "pretrain", "pretrained", "init", "config", "cfg",
]);

/** A template is a string, so numeric flags can't be per-run. */
function templatable(arg) {
  const type = String(arg.type || "").toLowerCase();
  return type !== "int" && type !== "float" && type !== "bool";
}

/** Only used to nudge the user; a miss just means no hint. */
function looksLikeArtifact(arg) {
  if (!templatable(arg)) return false;
  const tokens = `${arg.dest || ""}_${arg.name || ""}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((t) => NOT_ARTIFACT.has(t))) return false;
  return tokens.some((t) => ARTIFACT.has(t));
}

function cartesianCombos(dims, fixed) {
  if (!dims.length) return [{ ...fixed }];
  let rows = [{}];
  for (const dim of dims) {
    const next = [];
    for (const row of rows) {
      for (const value of dim.values) next.push({ ...row, [dim.dest]: value });
    }
    rows = next;
  }
  return rows.map((row) => ({ ...fixed, ...row }));
}

/** Grid dimensions (the cartesian product) plus the value each run sees. */
function sweepPlan(spec, state) {
  const byDest = Object.fromEntries((spec?.args || []).map((a) => [a.dest, a]));
  const perRun = state.perRun || [];
  const dims = [];
  const fixed = {};
  for (const [dest, slots] of Object.entries(state.values || {})) {
    if (perRun.includes(dest)) continue;
    const arg = byDest[dest];
    const clean = (slots || []).filter((v) => v !== "" && v !== null && v !== undefined);
    if (!clean.length) continue;
    fixed[dest] = clean[0];
    if (clean.length > 1) {
      dims.push({ dest, name: arg?.name || dest, values: clean, count: clean.length });
    }
  }
  for (const row of state.overrideRows || []) {
    const key = row.key.trim();
    if (!key) continue;
    const vals = row.vals.map((v) => v.trim()).filter(Boolean);
    if (!vals.length) continue;
    fixed[key] = vals[0];
    if (vals.length > 1) dims.push({ dest: key, name: key, values: vals, count: vals.length });
  }
  const combos = cartesianCombos(dims, fixed);
  return { dims, count: combos.length, combos, first: combos[0] || {}, last: combos[combos.length - 1] || {} };
}

function suggestTemplate(value, dims) {
  const base = String(value ?? "").replace(/[\\/]+$/, "");
  const tail = dims.length && dims.length <= 2 ? dims.map((d) => `{${d.dest}}`).join("-") : "{i}";
  if (!base) return `./runs/${tail}`;
  return /[\\/]/.test(base) ? `${base}/${tail}` : `${base}-${tail}`;
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
  const perRun = state.perRun || [];
  const values = {};
  let sweep = false;
  for (const [k, arr] of Object.entries(state.values)) {
    const arg = perRun.includes(k) ? null : byDest[k];
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
    per_run: perRun.filter((k) => typeof values[k] === "string"),
  };
}

function formSnapshot(state) {
  return JSON.stringify({
    values: state.values,
    extra: state.extra || "",
    overrideRows: state.overrideRows || [],
    envRows: state.envRows || [],
    perRun: state.perRun || [],
    gpus: state.gpus || [],
    gpuPolicy: state.gpuPolicy || "pin",
    python: state.python || "",
    cwd: state.cwd || "",
  });
}

export default function Launch() {
  const { wsId } = useParams();
  const [params] = useSearchParams();
  const script = params.get("script");
  const { gpu, settings, setSettings, toast, refresh } = useKiln();
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
        const draft = readLaunchDraft(wsId, script);
        const values = {};
        const adjusted = [];
        const cudaNow = hasCuda(gpuInfo);
        for (const arg of spec.args || []) {
          const raw = defaultValue(arg);
          const saved = draft?.values?.[arg.dest];
          if (saved !== undefined && saved !== null) {
            values[arg.dest] = Array.isArray(saved) ? saved : [saved];
            continue;
          }
          const next = preferLocalDevice(arg, raw, cudaNow);
          values[arg.dest] = [next];
          if (String(next) !== String(raw)) adjusted.push(arg.dest);
        }
        const hydraBlank = spec.kind === "hydra" ? [{ key: "", vals: [""] }] : [];
        const overrideRows =
          Array.isArray(draft?.overrideRows) && draft.overrideRows.length ? draft.overrideRows : hydraBlank;
        const envRows =
          Array.isArray(draft?.envRows) && draft.envRows.length ? draft.envRows : [{ key: "", value: "" }];
        const presetList = presets.presets || [];
        const activeId = draft?.activePresetId;
        const stillThere = presetList.some((p) => p.id === activeId);
        setReady({ spec, ws, interpreters: interpreters.interpreters || [] });
        setL({
          values,
          extra: typeof draft?.extra === "string" ? draft.extra : "",
          overrideRows,
          envRows,
          perRun: Array.isArray(draft?.perRun) ? draft.perRun.filter((dest) => dest in values) : [],
          gpus: Array.isArray(draft?.gpus) ? draft.gpus : [],
          gpuPolicy: draft?.gpuPolicy === "pin" ? "pin" : "spread",
          python: draft?.python || ws.python || "",
          cwd: typeof draft?.cwd === "string" ? draft.cwd : "",
          presets: presetList,
          activePresetId: stillThere ? activeId : null,
          presetBaseline: stillThere ? draft?.presetBaseline || null : null,
          adjusted: draft ? [] : adjusted,
        });
        if (typeof draft?.cliText === "string") setCliText(draft.cliText);
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
        perRun: L.perRun,
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

  function persistDraft(state = L, cli = cliText) {
    if (!state || !script) return;
    writeLaunchDraft(wsId, script, {
      values: state.values,
      extra: state.extra,
      overrideRows: state.overrideRows,
      envRows: state.envRows,
      perRun: state.perRun,
      gpus: state.gpus,
      gpuPolicy: state.gpuPolicy,
      python: state.python,
      cwd: state.cwd,
      cliText: cli,
      activePresetId: state.activePresetId || null,
      presetBaseline: state.presetBaseline || null,
    });
  }

  useEffect(() => {
    if (!L) return undefined;
    const t = setTimeout(() => persistDraft(L, cliText), 200);
    return () => clearTimeout(t);
  }, [L, cliText, wsId, script]);

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
      persistDraft();
      toast(`已提交 ${data.count} 个任务${data.max_concurrent ? ` · 同时 ${data.max_concurrent} 路` : ""}`);
      refresh();
    } catch (err) {
      toast(err.message);
    }
  }

  async function reloadPresets() {
    const data = await api(`/presets?workspace_id=${wsId}&script=${encodeURIComponent(script)}`);
    return data.presets || [];
  }

  async function createPreset(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) {
      toast("先填一个预设名称");
      return;
    }
    const payload = collectPayload(wsId, script, L, ready.spec);
    try {
      const created = await api("/presets", {
        method: "POST",
        body: { workspace_id: Number(wsId), script, name: trimmed, payload },
      });
      const list = await reloadPresets();
      patch((prev) => {
        const next = { ...prev, presets: list, presetName: "", activePresetId: created.id };
        next.presetBaseline = formSnapshot(next);
        return next;
      });
      toast(`已新建「${trimmed}」`);
    } catch (err) {
      toast(err.message);
    }
  }

  async function overwritePreset() {
    if (!L.activePresetId) {
      toast("还没有当前预设，先新建或选一个");
      return;
    }
    const payload = collectPayload(wsId, script, L, ready.spec);
    try {
      await api(`/presets/${L.activePresetId}`, { method: "PATCH", body: { payload } });
      const list = await reloadPresets();
      patch((prev) => {
        const next = { ...prev, presets: list };
        next.presetBaseline = formSnapshot(next);
        return next;
      });
      const name = (L.presets.find((p) => p.id === L.activePresetId) || {}).name || "当前预设";
      toast(`已覆盖「${name}」`);
    } catch (err) {
      toast(err.message);
    }
  }

  async function renamePreset(id, name) {
    const trimmed = (name || "").trim();
    if (!trimmed) {
      toast("名称不能为空");
      return false;
    }
    try {
      await api(`/presets/${id}`, { method: "PATCH", body: { name: trimmed } });
      const list = await reloadPresets();
      patch((prev) => ({ ...prev, presets: list }));
      toast("已改名");
      return true;
    } catch (err) {
      toast(err.message);
      return false;
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
    patch((prev) => {
      const next = {
        ...prev,
        values,
        perRun: (p.per_run || []).filter((dest) => dest in values),
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
        activePresetId: id,
      };
      next.presetBaseline = formSnapshot(next);
      return next;
    });
    toast(`已套用 ${preset.name}`);
  }

  async function deletePreset(id, name) {
    if (!confirm(`删除预设「${name}」？`)) return;
    try {
      await api(`/presets/${id}`, { method: "DELETE" });
      const list = await reloadPresets();
      patch((prev) => ({
        ...prev,
        presets: list,
        activePresetId: prev.activePresetId === id ? null : prev.activePresetId,
        presetBaseline: prev.activePresetId === id ? null : prev.presetBaseline,
      }));
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
  const plan = sweepPlan(spec, L);
  const perRunNames = (L.perRun || []).map((dest) => args.find((a) => a.dest === dest)?.name || dest);
  const presetDirty = !!(L.activePresetId && L.presetBaseline && formSnapshot(L) !== L.presetBaseline);

  return (
    <div className="@container">
      <PageHeader
        className="mb-4"
        kicker={
          <>
            <Link to={`/ws/${wsId}`} className="text-muted underline-offset-2 hover:text-text hover:underline">
              脚本列表
            </Link>
            {` · ${spec.kind || "raw"} · ${ready.ws.name}`}
          </>
        }
        title={script}
        lede={spec.description || spec.error || "把命令行参数填进表单。确认命令预览后再运行。"}
        actions={
          <Link
            to={`/ws/${wsId}`}
            className="inline-flex items-center rounded-lg border border-line px-3 py-1.5 text-sm no-underline hover:bg-hover"
          >
            ← 返回脚本列表
          </Link>
        }
      />
      <Hint className="mb-4">
        <ul>
          <li>
            <code>nargs=+</code> 的框用空格填写多个值（如 <code>1 2 3 4</code>，逗号也可以）。可把一整条命令粘贴到「从命令行填入」解析进表单。
          </li>
          <li>
            消融分两堆：「+ 多值」的参数做笛卡尔积决定跑几组；「每组唯一」的参数不参与相乘，写成模板按组展开，例如{" "}
            <code>./runs/&#123;arch&#125;-&#123;lr&#125;</code> 或 <code>./runs/exp-&#123;i&#125;</code>
            ，用来避免几组任务把产物写到同一个目录。占位符可用 <code>&#123;i&#125;</code>（组序号）、
            <code>&#123;n&#125;</code>（总组数）和任意参与消融的参数名。
          </li>
          <li>
            脚本自己管卡时：界面上<strong className="font-medium text-text">不要选卡</strong>
            。Kiln 不会设置 <code>CUDA_VISIBLE_DEVICES</code>
            ，脚本里的 <code>cuda:0</code> 按机器真实编号生效。多路一起跑时把侧栏「同时最多几路」压低，避免打满同一张卡。要让
            Kiln 排队、互斥，就把卡勾上，脚本里用相对可见设备（通常是 <code>cuda:0</code>）。
          </li>
        </ul>
      </Hint>
      <div className="grid items-start gap-4 @[780px]:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
        <div className="min-w-0 space-y-4">
          <Panel>
            <h2 className="text-[15px] font-semibold">从命令行填入</h2>
            <p className="mt-1 mb-2 text-xs text-muted">粘贴一整条命令，解析出来的参数会覆盖下面的表单。</p>
            <textarea
              value={cliText}
              onChange={(e) => setCliText(e.target.value)}
              placeholder="python train.py --aa 1 2 3 4 --lr 1e-4"
            />
            <Button size="sm" className="mt-2" onClick={applyCli}>
              解析并填入
            </Button>
          </Panel>
          <Panel>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[15px] font-semibold">参数</h2>
              {plan.dims.length ? (
                <span className="text-xs text-muted">
                  笛卡尔积 <b className="text-text">{plan.count}</b> 组 ={" "}
                  <span className="font-mono">{plan.dims.map((d) => `${d.name}×${d.count}`).join(" × ")}</span>
                  {perRunNames.length ? (
                    <>
                      {" · "}每组唯一：<span className="font-mono text-ember">{perRunNames.join(" ")}</span>
                    </>
                  ) : null}
                </span>
              ) : null}
            </div>
            {args.length ? (
              <div>
                {args.map((arg) => (
                  <ArgRow
                    key={arg.dest}
                    arg={arg}
                    vals={L.values[arg.dest] ?? [defaultValue(arg)]}
                    tweaked={(L.adjusted || []).includes(arg.dest)}
                    perRun={(L.perRun || []).includes(arg.dest)}
                    plan={plan}
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
                    onPerRun={(on, template) =>
                      patch((prev) => {
                        const rest = (prev.perRun || []).filter((d) => d !== arg.dest);
                        const cur = prev.values[arg.dest] || [""];
                        const next = template === undefined ? [cur[0] ?? ""] : [template];
                        return {
                          ...prev,
                          perRun: on ? [...rest, arg.dest] : rest,
                          values: { ...prev.values, [arg.dest]: on ? next : cur },
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

        <div className="min-w-0 @[780px]:sticky @[780px]:top-4 @[780px]:self-start">
          <Panel className="@[780px]:max-h-[calc(100dvh-8rem)] @[780px]:overflow-y-auto @[780px]:overscroll-contain">
            <div className="mb-2 text-[13px] font-semibold text-muted">命令预览</div>
            <pre className="max-h-40 overflow-auto rounded-lg border border-line bg-[#181511] p-3 font-mono text-xs break-all whitespace-pre-wrap text-muted">
              {preview.text}
            </pre>
            {preview.hint && <p className="mt-2 text-xs text-muted">{preview.hint}</p>}
            <div className="mt-4 mb-1 text-[13px] font-semibold text-muted">设备</div>
            {cuda ? (
              <p className="text-xs text-muted">
                脚本自己管卡就别勾选，Kiln 不会动 <code className="text-text">CUDA_VISIBLE_DEVICES</code>。
              </p>
            ) : null}
            <GpuPick gpu={gpu} selected={L.gpus} onChange={(gpus) => patch((prev) => ({ ...prev, gpus }))} />
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
            <div className="mt-4 grid gap-2.5 @[560px]:grid-cols-2 @[780px]:grid-cols-1">
              <Field label="Python">
                <select value={L.python} onChange={(e) => patch((prev) => ({ ...prev, python: e.target.value }))}>
                  {pythonOptions.map((o) => (
                    <option key={o.path || "default"} value={o.path}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="工作目录" className="@[560px]:col-span-2 @[780px]:col-span-1">
                <input
                  value={L.cwd}
                  onChange={(e) => patch((prev) => ({ ...prev, cwd: e.target.value }))}
                  placeholder="默认：脚本所在目录"
                />
              </Field>
            </div>
          </Panel>
        </div>
      </div>

      <div className="sticky bottom-0 z-20 -mx-4 -mb-6 mt-4 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-10 lg:-mb-8 lg:px-10">
        <div className="flex flex-wrap items-center gap-2">
          <PresetMenu
            presets={L.presets}
            activeId={L.activePresetId}
            dirty={presetDirty}
            name={L.presetName || ""}
            onName={(presetName) => patch((prev) => ({ ...prev, presetName }))}
            onApply={applyPreset}
            onCreate={() => createPreset(L.presetName)}
            onOverwrite={overwritePreset}
            onRename={renamePreset}
            onDelete={deletePreset}
          />
          {preview.hint && <span className="ml-auto hidden text-xs text-muted md:block">{preview.hint}</span>}
          <div className={`flex gap-2 ${preview.hint ? "md:ml-0" : ""} ml-auto`}>
            <Button onClick={() => runPreview(L, true)}>预览</Button>
            <Button variant="solid" onClick={doLaunch}>
              {preview.count > 1 ? `运行 × ${preview.count}` : "运行"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PresetMenu({ presets, activeId, dirty, name, onName, onApply, onCreate, onOverwrite, onRename, onDelete }) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameText, setRenameText] = useState("");
  const box = useRef(null);
  const active = presets.find((p) => p.id === activeId);
  const label = active ? `${active.name}${dirty ? "*" : ""}` : "预设";

  useEffect(() => {
    if (!open) {
      setRenamingId(null);
      return undefined;
    }
    function onDown(e) {
      if (!box.current?.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") {
        if (renamingId != null) setRenamingId(null);
        else setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, renamingId]);

  async function commitRename(id) {
    const ok = await onRename(id, renameText);
    if (ok) setRenamingId(null);
  }

  return (
    <div className="relative" ref={box}>
      <Button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={active ? (dirty ? `${active.name}（有未保存的修改）` : active.name) : "预设"}
      >
        <span className="max-w-[9.5rem] truncate">{label}</span>
        <span className={`ml-1.5 text-[9px] text-muted transition-transform ${open ? "rotate-180" : ""}`}>▲</span>
      </Button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-80 rounded-xl border border-[#4d453a] bg-hover p-2 shadow-[0_12px_32px_rgba(0,0,0,.6)]">
          {presets.length ? (
            <div className="max-h-56 overflow-y-auto overscroll-contain">
              {presets.map((p) => {
                const on = p.id === activeId;
                return (
                  <div
                    key={p.id}
                    className={`flex items-center gap-1 rounded-lg ${on ? "bg-ember-soft" : "hover:bg-line/60"}`}
                  >
                    {renamingId === p.id ? (
                      <input
                        className="min-w-0 flex-1 py-1"
                        value={renameText}
                        autoFocus
                        onChange={(e) => setRenameText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitRename(p.id);
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm"
                        title={`套用 ${p.name}`}
                        onClick={() => {
                          onApply(p.id);
                          setOpen(false);
                        }}
                      >
                        {p.name}
                        {on && dirty ? <span className="text-ember">*</span> : null}
                      </button>
                    )}
                    {renamingId === p.id ? (
                      <button
                        type="button"
                        className="shrink-0 rounded-md px-2 py-1 text-xs hover:bg-panel"
                        onClick={() => commitRename(p.id)}
                      >
                        确定
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="shrink-0 rounded-md px-2 py-1 text-xs text-muted hover:bg-panel hover:text-text"
                        title={`更名 ${p.name}`}
                        onClick={() => {
                          setRenamingId(p.id);
                          setRenameText(p.name);
                        }}
                      >
                        更名
                      </button>
                    )}
                    <button
                      type="button"
                      className="shrink-0 rounded-md px-2 py-1 text-xs text-muted hover:bg-bad-soft hover:text-bad"
                      title={`删除 ${p.name}`}
                      onClick={() => onDelete(p.id, p.name)}
                    >
                      删除
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="px-2 py-2 text-xs text-muted">还没有预设。给当前这套参数起个名字新建一份。</p>
          )}
          <div className="mt-1.5 space-y-1.5 border-t border-line pt-2">
            <div className="flex gap-1.5">
              <input
                className="min-w-0 flex-1"
                placeholder="新预设名称"
                value={name}
                onChange={(e) => onName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCreate();
                }}
              />
              <Button size="sm" onClick={onCreate}>
                新建
              </Button>
            </div>
            <Button
              size="sm"
              className="w-full"
              disabled={!active}
              title={active ? `把当前表单写入「${active.name}」` : "先选一个预设"}
              onClick={onOverwrite}
            >
              {active ? `覆盖「${active.name}」` : "覆盖当前预设"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function sampleValues(values, max = 3) {
  const shown = values.slice(0, max).map((v) => String(v));
  if (values.length > max) shown.push("…");
  return shown.join(" / ");
}

function PerRunEditor({ template, plan, onChange, onCancel }) {
  const inputRef = useRef(null);
  const caret = useRef(null);
  const dims = plan?.dims || [];
  const combos = plan?.combos || [{}];
  const total = combos.length || 1;
  const hasPlaceholder = /\{[A-Za-z_][A-Za-z0-9_]*\}/.test(template);
  const previewIdx =
    total <= 4
      ? combos.map((_, i) => i)
      : [0, 1, total - 1].filter((i, n, arr) => arr.indexOf(i) === n);

  useEffect(() => {
    const el = inputRef.current;
    const pos = caret.current;
    if (!el || pos == null) return;
    el.focus();
    el.setSelectionRange(pos, pos);
    caret.current = null;
  }, [template]);

  function insert(token) {
    const el = inputRef.current;
    const start = el?.selectionStart ?? template.length;
    const end = el?.selectionEnd ?? template.length;
    caret.current = start + token.length;
    onChange(template.slice(0, start) + token + template.slice(end));
  }

  const chips = [
    { token: "{i}", title: "组序号", hint: `1 … ${total}` },
    { token: "{n}", title: "总组数", hint: String(total) },
    ...dims.map((d) => ({
      token: `{${d.dest}}`,
      title: `该组 ${d.name}`,
      hint: sampleValues(d.values),
    })),
  ];

  return (
    <div className="mt-2 rounded-lg border border-line bg-[#181511] p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          className="min-w-0 flex-1"
          value={template}
          placeholder="./runs/exp-{lr}-{i}"
          onChange={(e) => onChange(e.target.value)}
        />
        <Button size="sm" title="改回普通参数" onClick={onCancel}>
          取消
        </Button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted">
        这是模板，Kiln 按每一组的消融取值替换花括号。
        {dims.length ? (
          <>
            {" "}
            例如 <code className="text-text">{`{${dims[0].dest}}`}</code> 会变成这一组{" "}
            <code className="text-text">{dims[0].name}</code> 实际填的值（{sampleValues(dims[0].values)}）。
          </>
        ) : (
          <>
            {" "}
            先给 <code className="text-text">--lr</code>、<code className="text-text">--arch</code> 这类点「+
            多值」，这里就会出现 <code className="text-text">{`{lr}`}</code>、
            <code className="text-text">{`{arch}`}</code>，点一下插进路径。
          </>
        )}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <button
            key={chip.token}
            type="button"
            className="rounded-md border border-line bg-panel px-2 py-1 text-left hover:border-ember/40"
            title={`插入 ${chip.token}：${chip.title}`}
            onClick={() => insert(chip.token)}
          >
            <span className="block font-mono text-[12px] text-text">{chip.token}</span>
            <span className="block text-[10px] text-muted">
              {chip.title} · {chip.hint}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-2.5 border-t border-line pt-2">
        <div className="mb-1 text-[11px] text-muted">
          {total > 1 ? `展开预览 · 共 ${total} 组` : "展开预览 · 现在只有 1 组，加上「+ 多值」之后会变成多行"}
        </div>
        {!hasPlaceholder && total > 1 ? (
          <p className="mb-1.5 text-[11px] text-warn">模板里还没有花括号，{total} 组会写成同一个路径。</p>
        ) : null}
        <div className="space-y-1">
          {previewIdx.map((i, n) => (
            <div key={i}>
              {n === previewIdx.length - 1 && previewIdx[n - 1] !== i - 1 && total > 4 ? (
                <div className="mb-1 text-[11px] text-muted">…</div>
              ) : null}
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 font-mono text-[11px]">
                <span className="shrink-0 text-muted">
                  {i + 1}/{total}
                </span>
                <span className="min-w-0 break-all text-text">
                  {renderTemplate(template, combos[i] || {}, i + 1, total)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ArgRow({ arg, vals, tweaked, perRun, plan, onChange, onSweep, onPerRun }) {
  const req = arg.required;
  const boolLike = arg.type === "bool" || arg.action === "store_true" || arg.action === "store_false";
  const singleChoice = !perRun && arg.choices && arg.choices.length && vals.length <= 1;
  const dims = plan?.dims || [];
  const total = plan?.count || 1;
  const collides = !perRun && total > 1 && vals.length === 1 && looksLikeArtifact(arg);

  if (perRun) {
    return (
      <div className="min-w-0 border-b border-line py-3 last:border-b-0">
        <ArgHead arg={arg} req={req} badge="每组唯一" />
        {arg.help ? <div className="mt-1 min-w-0 text-xs break-all text-muted">{arg.help}</div> : null}
        <PerRunEditor
          template={String(vals[0] ?? "")}
          plan={plan}
          onChange={(next) => onPerRun(true, next)}
          onCancel={() => onPerRun(false)}
        />
      </div>
    );
  }

  return (
    <div className="min-w-0 border-b border-line py-3 last:border-b-0">
      <ArgHead arg={arg} req={req} badge={vals.length > 1 ? `网格 ×${vals.length}` : ""} />
      {arg.help ? <div className="mt-1 min-w-0 text-xs break-all text-muted">{arg.help}</div> : null}
      {isNargsList(arg) ? (
        <div className="mt-1 text-xs text-muted">空格分隔多个值，对应 --flag 1 2 3 4；逗号也会当成分隔符。点「+ 多值」才是消融成多条任务。</div>
      ) : null}
      {tweaked ? (
        <div className="mt-1 min-w-0 text-xs break-all text-muted">
          本机没有 CUDA，已从默认 {String(arg.default)} 改为 {String(vals[0])}
        </div>
      ) : null}
      {collides ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-warn/35 bg-warn-soft/40 px-2 py-1.5 text-xs text-warn">
          <span className="min-w-0">这看着像产物路径，{total} 组会全写到同一个地方。</span>
          <button
            type="button"
            className="rounded-md border border-warn/40 px-1.5 py-0.5 text-[11px] hover:bg-warn/15"
            onClick={() => onPerRun(true, suggestTemplate(vals[0], dims))}
          >
            设为每组唯一
          </button>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {boolLike ? (
          <>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {vals.map((v, i) => (
                <span key={i} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-hover px-2 py-1">
                  <Toggle
                    on={isTruthy(v)}
                    onClick={() => {
                      const next = [...vals];
                      next[i] = !isTruthy(v);
                      onChange(next);
                    }}
                  />
                  <span className="text-xs text-muted">{isTruthy(v) ? "true" : "false"}</span>
                  {vals.length > 1 && (
                    <button
                      type="button"
                      className="px-1 text-muted"
                      onClick={() => {
                        const next = vals.filter((_, idx) => idx !== i);
                        onChange(next.length ? next : [false]);
                      }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
            {!(vals.some(isTruthy) && vals.some((v) => !isTruthy(v))) ? (
              <Button
                size="sm"
                title="再加 true 或 false，生成消融任务"
                onClick={() => onChange([...vals, !isTruthy(vals[0])])}
              >
                + 多值
              </Button>
            ) : null}
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
            <Button size="sm" title="添加一组值，参与笛卡尔积" onClick={onSweep}>
              + 多值
            </Button>
            {vals.length === 1 && !isNargsList(arg) && templatable(arg) ? (
              <Button
                size="sm"
                title="不参与相乘：写成模板，每组展开成不同的值"
                onClick={() => onPerRun(true, suggestTemplate(vals[0], dims))}
              >
                每组唯一
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ArgHead({ arg, req, badge }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 font-mono text-[13px] break-all">
          {arg.name} {req ? <span className="text-bad">*</span> : null}
        </span>
        {badge ? (
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
              badge === "每组唯一" ? "bg-ember-soft text-ember" : "bg-hover text-muted"
            }`}
          >
            {badge}
          </span>
        ) : null}
      </span>
      <span className="min-w-0 max-w-[45%] text-right text-xs break-all text-muted">
        {arg.type || ""}
        {arg.nargs ? ` · nargs=${arg.nargs}` : ""}
        {arg.default !== undefined && arg.default !== null ? ` · 默认 ${formatDefault(arg)}` : ""}
      </span>
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
          这台机器没有 NVIDIA GPU{name ? `（${name}）` : ""}。任务会按侧栏「同时最多几路」做普通进程并发。在 Linux
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
  const ids = gpus.map((g) => String(g.index));
  const picked = (selected || []).filter((id) => ids.includes(id));
  return (
    <>
      <div className="mt-2 mb-1 flex items-center gap-2 text-xs text-muted">
        <span>
          已选 {picked.length} / {gpus.length}
        </span>
        <button type="button" className="ml-auto hover:text-text" onClick={() => onChange(ids)}>
          全选
        </button>
        <span className="text-line">|</span>
        <button type="button" className="hover:text-text" onClick={() => onChange([])}>
          清空
        </button>
      </div>
      <div className="mb-2 grid gap-1 @[560px]:grid-cols-2 @[780px]:grid-cols-1">
        {gpus.map((g) => {
          const id = String(g.index);
          const on = (selected || []).includes(id);
          const run = (g.running || [])[0];
          return (
            <label
              key={id}
              className={`grid cursor-pointer grid-cols-[auto_1fr] items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[13px] ${
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
              <span className="min-w-0">
                <b>{id}</b> <span className="break-all">{g.name}</span>
                <span className="text-muted">
                  {" "}
                  {run ? `占用 ${run.script}` : "空闲"} · {Math.round(g.memory_used)}/{Math.round(g.memory_total)}G
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </>
  );
}
