const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const STATUS = {
  queued: "排队",
  running: "运行中",
  succeeded: "完成",
  failed: "失败",
  stopped: "已停",
  interrupted: "中断",
};

const state = {
  gpu: null,
  jobs: [],
  interpreters: [],
  settings: { max_concurrent: 8, gpu_exclusive: true },
  launch: null,
  logSource: null,
};

let renderSeq = 0;

function isStale(token) {
  return !token || token.seq !== renderSeq || (location.hash || "#/") !== token.hash;
}

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { detail: text };
  }
  if (!res.ok) {
    const detail = data && data.detail;
    const msg = typeof detail === "string" ? detail : JSON.stringify(detail || data);
    throw new Error(msg || res.statusText);
  }
  return data;
}

function toast(msg) {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseHash() {
  const raw = location.hash.slice(1) || "/";
  const [path, qs] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  return { parts, params: new URLSearchParams(qs || "") };
}

function setNav() {
  const { parts } = parseHash();
  $$(".nav a").forEach((a) => a.classList.remove("active"));
  paintWsNav();
  let key = "home";
  if (parts[0] === "jobs") key = "jobs";
  else if (parts[0] === "ws") key = "ws";
  const link = $(`.nav a[data-nav="${key}"]`);
  if (link && !link.hidden) link.classList.add("active");
  else {
    const home = $(`.nav a[data-nav="home"]`);
    if (home) home.classList.add("active");
  }
}

function rememberWorkspace(id, name) {
  if (!id) return;
  sessionStorage.setItem("kiln-ws-id", String(id));
  if (name) sessionStorage.setItem("kiln-ws-name", name);
  paintWsNav();
}

function paintWsNav() {
  const a = $("#nav-ws");
  if (!a) return;
  const id = sessionStorage.getItem("kiln-ws-id");
  const name = sessionStorage.getItem("kiln-ws-name") || "当前项目";
  if (!id) {
    a.hidden = true;
    return;
  }
  a.hidden = false;
  a.href = `#/ws/${id}`;
  a.textContent = name;
}

async function refreshChrome() {
  try {
    const [gpu, jobs, settings] = await Promise.all([
      api("/gpu"),
      api("/jobs"),
      api("/settings"),
    ]);
    state.gpu = gpu;
    state.jobs = jobs.jobs || [];
    state.settings = settings;
    renderGpu();
    const running = state.jobs.filter((j) => j.status === "running" || j.status === "queued").length;
    const fire = $("#fire-count");
    if (running) {
      fire.hidden = false;
      fire.textContent = `${running} 个任务进行中`;
    } else {
      fire.hidden = true;
    }
    if ($("#job-board")) paintJobBoard();
  } catch {
    /* kiln backend down */
  }
}

function hasCuda() {
  return !!(state.gpu?.cuda || (state.gpu?.gpus || []).length);
}

function adapterLabel() {
  const adapters = state.gpu?.adapters || [];
  return adapters[0] || "";
}

function renderGpu() {
  const root = $("#gpu-strip");
  const gpus = state.gpu?.gpus || [];
  if (!gpus.length) {
    const name = adapterLabel();
    const n = (state.jobs || []).filter((j) => j.status === "running").length;
    root.innerHTML = `<div class="gpu-chip">
      <b>CPU</b> ${name ? esc(name) : "无 NVIDIA / CUDA"}
      <div>${n ? n + " 个进程在跑" : "无 CUDA 卡 · 进程仍可并发"}</div>
    </div>`;
    return;
  }
  root.innerHTML = gpus
    .map((g) => {
      const mem = g.memory_total ? (g.memory_used / g.memory_total) * 100 : 0;
      const util = g.utilization || 0;
      const run = (g.running || [])[0];
      const qn = (g.queued || []).length;
      const line = run ? `在跑 ${run.script}` : qn ? `排队 ${qn}` : "空闲";
      return `<div class="gpu-chip ${run ? "busy" : ""}">
        <b>GPU ${g.index}</b> ${esc(g.name).slice(0, 16)}
        <div>${Math.round(g.memory_used)}/${Math.round(g.memory_total)}G · ${Math.round(g.temperature)}°</div>
        <div>${esc(line)}</div>
        <div class="gpu-bar"><i style="width:${Math.max(mem, util)}%"></i></div>
      </div>`;
    })
    .join("");
}

async function render() {
  const token = { seq: ++renderSeq, hash: location.hash || "#/" };
  setNav();
  if (state.logSource) {
    state.logSource.close();
    state.logSource = null;
  }
  const { parts, params } = parseHash();
  const view = $("#view");
  try {
    if (parts[0] === "jobs" && parts[1]) await renderLog(view, parts[1], token);
    else if (parts[0] === "jobs") await renderJobs(view, token);
    else if (parts[0] === "ws" && parts[2] === "run") await renderLaunch(view, parts[1], params.get("script"), token);
    else if (parts[0] === "ws") await renderScripts(view, parts[1], token);
    else await renderHome(view, token);
  } catch (err) {
    if (isStale(token)) return;
    view.innerHTML = `<div class="empty"><strong>加载失败</strong>${esc(err.message)}</div>`;
  }
}

async function renderHome(view, token) {
  const data = await api("/workspaces");
  if (isStale(token)) return;
  const list = data.workspaces || [];
  view.innerHTML = `
    <p class="kicker">工作区</p>
    <h1>你的训练项目</h1>
    <p class="lede">把仓库根目录加进来。Kiln 会列出 Python 脚本，把命令行参数变成表单，确认后再运行，不必手敲一长串 CLI。</p>
    <div class="hint">
      <strong>怎么用</strong>
      <ol>
        <li>填写下面的项目路径（Windows 如 <code>D:\\research\\cls</code>，Linux 如 <code>/data/exp</code>），添加工作区。</li>
        <li>进入工作区后选一个脚本，填参数，看右侧命令预览，再点「运行」。</li>
        <li>到左侧「任务」查看排队、日志、tqdm 进度，并可随时停止。</li>
      </ol>
      也可以先点「加载示例」走一遍流程。
    </div>
    <form class="inline-form panel" id="ws-form">
      <label class="field">名称<input name="name" placeholder="例如 ImageNet 消融" /></label>
      <label class="field">项目路径<input name="path" placeholder="训练仓库的根目录" required /></label>
      <label class="field">Python（可选）<input name="python" placeholder="留空则用当前解释器；conda 环境填 python 路径" /></label>
      <button class="btn solid" type="submit">添加工作区</button>
      <button class="btn ghost" type="button" id="load-examples">加载示例</button>
    </form>
    ${
      list.length
        ? `<div class="tickets">${list
            .map(
              (w) => `<a class="ticket" href="#/ws/${w.id}">
            <div class="badges"><span class="badge">工作区</span></div>
            <div class="path">${esc(w.name)}</div>
            <div class="meta">${esc(w.path)}</div>
          </a>`
            )
            .join("")}</div>`
        : `<div class="empty"><strong>还没有工作区</strong>填一个训练项目的根目录，或先加载自带示例看效果。</div>`
    }
  `;
  $("#ws-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const ws = await api("/workspaces", {
        method: "POST",
        body: {
          name: fd.get("name"),
          path: fd.get("path"),
          python: fd.get("python") || null,
        },
      });
      location.hash = `#/ws/${ws.id}`;
    } catch (err) {
      toast(err.message);
    }
  });
  $("#load-examples").addEventListener("click", async () => {
    try {
      const ws = await api("/workspaces/examples", { method: "POST", body: {} });
      location.hash = `#/ws/${ws.id}`;
    } catch (err) {
      toast(err.message);
    }
  });
}

async function renderScripts(view, wsId, token) {
  const showHidden = sessionStorage.getItem("kiln-hidden") === "1";
  const data = await api(`/workspaces/${wsId}/scripts?hidden=${showHidden ? "true" : "false"}`);
  if (isStale(token)) return;
  const ws = data.workspace;
  rememberWorkspace(ws.id, ws.name);
  let scripts = data.scripts || [];
  view.innerHTML = `
    <p class="kicker"><a href="#/">工作区</a> / ${esc(ws.name)}</p>
    <div class="toolbar">
      <div>
        <h1>${esc(ws.name)}</h1>
        <p class="lede">${esc(ws.path)}</p>
      </div>
      <div class="row">
        <button class="btn ghost small" id="rescan">重新扫描</button>
        <button class="btn ghost small" id="toggle-hidden">${showHidden ? "隐藏已移除" : "显示已移除"}</button>
        <button class="btn danger small" id="del-ws">删除工作区</button>
      </div>
    </div>
    <div class="hint">
      <strong>这一页</strong>
      点脚本名称或「填参数」进入表单。自动扫描可能漏掉较深目录或 data/ 下的文件，可用「手动添加」。从列表移除不会删除磁盘上的代码，重新扫描也不会把它加回来，除非你再手动添加或点恢复。
    </div>
    <form class="inline-form panel" id="add-script">
      <label class="field">手动添加脚本
        <input name="path" placeholder="相对路径，如 train.py 或 tools/infer.py" required />
      </label>
      <button class="btn solid" type="submit">添加到列表</button>
    </form>
    <input class="search" id="q" placeholder="过滤脚本路径…" />
    <div class="script-list" id="script-list"></div>
  `;
  const paint = () => {
    const q = $("#q").value.trim().toLowerCase();
    const items = scripts.filter((s) => !q || s.path.toLowerCase().includes(q));
    let empty;
    if (items.length) empty = "";
    else if (q) empty = `<div class="empty"><strong>没有匹配「${esc($("#q").value.trim())}」的脚本</strong>清空搜索框即可看到全部 ${scripts.length} 个。</div>`;
    else empty = `<div class="empty"><strong>列表是空的</strong>点「重新扫描」，或在上面手动添加一个 .py 路径。</div>`;
    $("#script-list").innerHTML = items.length
      ? items
          .map((s) => {
            const badges = [];
            if (s.source === "manual") badges.push("手动");
            if (s.missing) badges.push("文件不存在");
            if (s.hidden) badges.push("已移除");
            if (s.has_main) badges.push("main");
            if (s.has_argparse) badges.push("argparse");
            if (s.has_hydra) badges.push("hydra");
            if (s.has_fire) badges.push("fire");
            if (s.has_click) badges.push("click");
            const runHref = `#/ws/${ws.id}/run?script=${encodeURIComponent(s.path)}`;
            return `<div class="script-row ${s.hidden ? "hidden" : ""}">
              <div>
                <a class="path" href="${s.hidden || s.missing ? "#" : runHref}">${esc(s.path)}</a>
                <div class="meta">${badges.map((b) => `<span class="badge">${b}</span>`).join(" ")} ${s.lines ? s.lines + " 行" : ""}</div>
              </div>
              <div class="row">
                ${s.hidden ? `<button class="btn small" data-unhide="${esc(s.path)}">恢复</button>` : `<a class="btn small solid" href="${runHref}">填参数</a>
                <button class="btn ghost small" data-hide="${esc(s.path)}">从列表移除</button>`}
              </div>
            </div>`;
          })
          .join("")
      : empty;
    $$("[data-hide]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/workspaces/${ws.id}/scripts/hide`, { method: "POST", body: { path: btn.dataset.hide, hidden: true } });
        render();
      });
    });
    $$("[data-unhide]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/workspaces/${ws.id}/scripts/hide`, { method: "POST", body: { path: btn.dataset.unhide, hidden: false } });
        render();
      });
    });
  };
  $("#q").addEventListener("input", paint);
  paint();
  $("#add-script").addEventListener("submit", async (e) => {
    e.preventDefault();
    const path = new FormData(e.target).get("path");
    try {
      await api(`/workspaces/${ws.id}/scripts`, { method: "POST", body: { path } });
      toast("已添加到列表");
      render();
    } catch (err) {
      toast(err.message);
    }
  });
  $("#rescan").addEventListener("click", async () => {
    try {
      const res = await api(`/workspaces/${ws.id}/scripts/scan?hidden=${showHidden ? "true" : "false"}`, { method: "POST", body: {} });
      scripts = res.scripts || [];
      toast(`扫描完成，列表 ${res.count} 个`);
      paint();
    } catch (err) {
      toast(err.message);
    }
  });
  $("#toggle-hidden").addEventListener("click", () => {
    sessionStorage.setItem("kiln-hidden", showHidden ? "0" : "1");
    render();
  });
  $("#del-ws").addEventListener("click", async () => {
    if (!confirm(`删除工作区 ${ws.name}？不会删除磁盘上的代码。`)) return;
    await api(`/workspaces/${ws.id}`, { method: "DELETE" });
    sessionStorage.removeItem("kiln-ws-id");
    sessionStorage.removeItem("kiln-ws-name");
    location.hash = "#/";
  });
}

function defaultValue(arg) {
  if (arg.default !== undefined && arg.default !== null) return arg.default;
  if (arg.action === "store_true") return false;
  if (arg.action === "store_false") return true;
  return "";
}

function choiceList(arg) {
  return (arg.choices || []).map((c) => String(c));
}

function preferLocalDevice(arg, value) {
  if (hasCuda()) return value;
  const choices = choiceList(arg).map((c) => c.toLowerCase());
  if (!choices.includes("cpu")) return value;
  const cur = String(value ?? "").toLowerCase();
  if (cur !== "cuda" && cur !== "gpu") return value;
  const cpu = (arg.choices || []).find((c) => String(c).toLowerCase() === "cpu");
  return cpu !== undefined ? cpu : "cpu";
}

async function renderLaunch(view, wsId, script, token) {
  if (!script) {
    view.innerHTML = `<div class="empty"><strong>未指定脚本</strong></div>`;
    return;
  }
  const [spec, presets, interpreters, wsPack] = await Promise.all([
    api(`/workspaces/${wsId}/parse?script=${encodeURIComponent(script)}`),
    api(`/presets?workspace_id=${wsId}&script=${encodeURIComponent(script)}`),
    api("/interpreters"),
    api(`/workspaces/${wsId}/scripts`),
  ]);
  if (isStale(token)) return;
  const ws = wsPack.workspace;
  rememberWorkspace(ws.id, ws.name);
  state.interpreters = interpreters.interpreters || [];
  const values = {};
  const adjusted = [];
  for (const arg of spec.args || []) {
    const raw = defaultValue(arg);
    const next = preferLocalDevice(arg, raw);
    values[arg.dest] = [next];
    if (String(next) !== String(raw)) adjusted.push(arg.dest);
  }
  const L = {
    spec,
    values,
    extra: "",
    overrideRows: spec.kind === "hydra" ? [{ key: "", vals: [""] }] : [],
    envRows: [{ key: "", value: "" }],
    gpu: "",
    gpus: [],
    gpuPolicy: "spread",
    python: ws.python || "",
    cwd: "",
    presets: presets.presets || [],
    adjusted,
  };
  state.launch = L;

  view.innerHTML = `
    <div class="page-head">
      <div class="toolbar">
        <div>
          <p class="kicker"><a href="#/ws/${esc(wsId)}">脚本列表</a> · ${esc(spec.kind || "raw")} · ${esc(ws.name)}</p>
          <h1>${esc(script)}</h1>
          <p class="lede" style="margin-bottom:0">${esc(spec.description || spec.error || "把命令行参数填进表单。确认右侧预览后再运行。")}</p>
        </div>
        <a class="btn ghost" href="#/ws/${esc(wsId)}">← 返回脚本列表</a>
      </div>
    </div>
    <div class="hint">
      <strong>这一页</strong>
      左侧是参数（解析自 argparse / Hydra / Fire / Click）。同一参数点「+ 多值」会生成一组消融任务。预设用来保存常用组合。确认右侧预览后再点「运行」。
    </div>
    <div class="split">
      <div>
        <div class="panel" style="margin-bottom:16px">
          <h2>预设</h2>
          <div class="row" id="preset-row">
            ${L.presets.map((p) => `<button class="btn ghost small" data-preset="${p.id}">${esc(p.name)}</button>`).join("")}
            <input id="preset-name" placeholder="预设名称" style="max-width:160px" />
            <button class="btn small" id="save-preset">保存当前</button>
          </div>
        </div>
        <div class="panel" style="margin-bottom:16px">
          <h2>参数</h2>
          <div id="args"></div>
          ${
            spec.kind === "hydra"
              ? `<div style="margin-top:16px"><div class="muted">Hydra 覆盖项 · 一行一个键，值可多个做消融</div><div id="overrides"></div>
                 <button class="btn ghost small" id="add-ov" type="button">+ 覆盖项</button></div>`
              : ""
          }
        </div>
        <div class="panel">
          <h2>额外参数 / 环境变量</h2>
          <label class="field">额外命令行参数
            <textarea id="extra" placeholder="解析不到的参数写这里，例如 --local_rank 0"></textarea>
          </label>
          <div id="env-rows" style="margin-top:12px"></div>
          <button class="btn ghost small" id="add-env" type="button">+ 环境变量</button>
        </div>
      </div>
      <div class="sticky">
        <div class="panel">
          <div class="stamp">运行配置</div>
          <p class="muted" style="margin:0 0 10px"><a href="#/ws/${esc(wsId)}">← 返回脚本列表</a></p>
          <label class="field">设备</label>
          <div id="gpu-pick" class="gpu-pick"></div>
          <div class="policy" id="gpu-policy">
            <label><input type="radio" name="gpol" value="spread" checked /> 每卡一进程，轮转分配</label>
            <label><input type="radio" name="gpol" value="pin" /> 每个进程都能看见所选卡（DDP）</label>
          </div>
          <label class="check" id="excl-wrap"><input type="checkbox" id="excl" ${state.settings.gpu_exclusive ? "checked" : ""} /> 同卡不叠 Kiln 任务</label>
          <label class="field" style="margin-top:10px">同时跑几路
            <input id="conc-launch" type="number" min="1" max="64" value="${esc(state.settings.max_concurrent)}" />
          </label>
          <p class="muted" id="conc-hint"></p>
          <label class="field" style="margin-top:10px">Python
            <select id="python">${pythonOptions(L.python)}</select>
          </label>
          <label class="field" style="margin-top:10px">工作目录
            <input id="cwd" placeholder="默认：脚本所在目录" />
          </label>
          <p class="muted" id="combo-hint" style="margin:12px 0 8px"></p>
          <div class="command" id="cmd-preview">预览命令…</div>
          <div class="row" style="margin-top:12px">
            <button class="btn ghost" id="preview">预览</button>
            <button class="btn solid" id="launch">运行</button>
          </div>
        </div>
      </div>
    </div>
  `;
  paintArgs();
  paintOverrides();
  paintEnv();
  paintGpuPick();
  $("#extra").addEventListener("input", (e) => {
    L.extra = e.target.value;
    schedulePreview();
  });
  $$("[name=gpol]").forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) L.gpuPolicy = r.value;
      schedulePreview();
    });
  });
  const exclBox = $("#excl");
  if (exclBox) {
    exclBox.addEventListener("change", async (e) => {
      try {
        state.settings = await api("/settings", { method: "POST", body: { gpu_exclusive: e.target.checked } });
        toast(e.target.checked ? "同卡不叠" : "允许同卡叠任务");
      } catch (err) {
        toast(err.message);
      }
    });
  }
  $("#conc-launch").addEventListener("change", async (e) => {
    try {
      state.settings = await api("/settings", { method: "POST", body: { max_concurrent: Number(e.target.value) } });
    } catch (err) {
      toast(err.message);
    }
  });
  $("#python").addEventListener("change", (e) => {
    L.python = e.target.value;
    schedulePreview();
  });
  $("#cwd").addEventListener("input", (e) => {
    L.cwd = e.target.value;
  });
  $("#preview").addEventListener("click", () => doPreview(true));
  $("#launch").addEventListener("click", doLaunch);
  $("#save-preset").addEventListener("click", savePreset);
  $("#add-env").addEventListener("click", () => {
    L.envRows.push({ key: "", value: "" });
    paintEnv();
  });
  const addOv = $("#add-ov");
  if (addOv) {
    addOv.addEventListener("click", () => {
      L.overrideRows.push({ key: "", vals: [""] });
      paintOverrides();
    });
  }
  $$("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(Number(btn.dataset.preset)));
  });
  const concHint = $("#conc-hint");
  if (concHint && !hasCuda()) {
    concHint.textContent = "没有 GPU 时建议 1–2 路，避免把 CPU 打满。";
  }
  doPreview(false);
}

function paintGpuPick() {
  const box = $("#gpu-pick");
  if (!box || !state.launch) return;
  const L = state.launch;
  const gpus = state.gpu?.gpus || [];
  const cuda = hasCuda();
  const pol = $("#gpu-policy");
  const excl = $("#excl-wrap");
  if (pol) pol.hidden = !cuda;
  if (excl) excl.hidden = !cuda;
  if (!gpus.length) {
    const name = adapterLabel();
    box.innerHTML = `<p class="muted">这台机器没有 NVIDIA GPU${name ? "（" + esc(name) + "）" : ""}。任务会按「同时跑几路」做普通进程并发。在 Linux 训练机上启动 Kiln 时，这里会列出 CUDA 卡。</p>
      <details><summary class="muted">仍要手写 CUDA_VISIBLE_DEVICES</summary>
        <input id="gpu-custom" placeholder="例如 0 或 0,1" value="${esc((L.gpus || []).join(","))}" />
      </details>`;
    const inp = $("#gpu-custom");
    if (inp) {
      inp.addEventListener("input", (e) => {
        L.gpus = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
        schedulePreview();
      });
    }
    return;
  }
  box.innerHTML = gpus
    .map((g) => {
      const id = String(g.index);
      const on = (L.gpus || []).includes(id);
      const run = (g.running || [])[0];
      return `<label class="gpu-opt ${on ? "on" : ""}">
        <input type="checkbox" data-gpu="${esc(id)}" ${on ? "checked" : ""} />
        <span><b>${esc(id)}</b> ${esc(g.name)}
          <span class="muted">${run ? "占用 " + esc(run.script) : "空闲"} · ${Math.round(g.memory_used)}/${Math.round(g.memory_total)}G</span>
        </span>
      </label>`;
    })
    .join("");
  $$("[data-gpu]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const id = String(inp.dataset.gpu);
      if (inp.checked) L.gpus = [...new Set([...(L.gpus || []), id])];
      else L.gpus = (L.gpus || []).filter((x) => x !== id);
      paintGpuPick();
      schedulePreview();
    });
  });
}

function pythonOptions(current) {
  const seen = new Set();
  const opts = [];
  const add = (path, label) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    const sel = path === current ? "selected" : "";
    opts.push(`<option value="${esc(path)}" ${sel}>${esc(label)}</option>`);
  };
  for (const it of state.interpreters) add(it.path, `${it.label} — ${it.path}`);
  if (current && !seen.has(current)) add(current, current);
  if (!opts.length) opts.push(`<option value="">默认</option>`);
  return opts.join("");
}

function paintArgs() {
  const L = state.launch;
  const box = $("#args");
  const args = L.spec.args || [];
  if (!args.length) {
    box.innerHTML = `<p class="muted">没有解析到参数，用右侧「额外命令行参数」直接写。</p>`;
    return;
  }
  box.innerHTML = args
    .map((arg) => {
      const req = arg.required ? `<span class="req">*</span>` : "";
      const vals = L.values[arg.dest] ?? [defaultValue(arg)];
      const tweaked = (L.adjusted || []).includes(arg.dest);
      return `<div class="arg" data-dest="${esc(arg.dest)}">
        <div class="arg-head">
          <span class="arg-name">${esc(arg.name)} ${req}</span>
          <span class="muted">${esc(arg.type || "")}${arg.default !== undefined && arg.default !== null ? " · 默认 " + esc(arg.default) : ""}</span>
        </div>
        ${arg.help ? `<div class="arg-help">${esc(arg.help)}</div>` : ""}
        ${tweaked ? `<div class="muted">本机没有 CUDA，已从默认 ${esc(arg.default)} 改为 ${esc(vals[0])}</div>` : ""}
        <div class="arg-controls">${argControl(arg, vals)}</div>
      </div>`;
    })
    .join("");
  bindArgControls();
}

function argControl(arg, vals) {
  if (arg.type === "bool" || arg.action === "store_true" || arg.action === "store_false") {
    const on = isTruthy(vals[0]);
    return `<button type="button" class="toggle ${on ? "on" : ""}" data-bool="${esc(arg.dest)}"><i></i></button>
            <span class="muted">${on ? "true" : "false"}</span>`;
  }
  if (arg.choices && arg.choices.length && vals.length <= 1) {
    const cur = vals[0];
    const options = arg.choices
      .map((c) => `<option value="${esc(c)}" ${String(c) === String(cur) ? "selected" : ""}>${esc(c)}</option>`)
      .join("");
    return `<select data-scalar="${esc(arg.dest)}">${options}</select>
            <button class="btn ghost small" data-sweep="${esc(arg.dest)}" type="button" title="添加一组值，生成消融任务">+ 多值</button>`;
  }
  const chips = vals
    .map(
      (v, i) => `<span class="chip">
        <input data-chip="${esc(arg.dest)}" data-i="${i}" value="${esc(v)}" />
        ${vals.length > 1 ? `<button type="button" data-del="${esc(arg.dest)}" data-i="${i}">×</button>` : ""}
      </span>`
    )
    .join("");
  return `<div class="chips">${chips}</div>
          <button class="btn ghost small" data-sweep="${esc(arg.dest)}" type="button" title="添加一组值，生成消融任务">+ 多值</button>`;
}

function bindArgControls() {
  const L = state.launch;
  $$("[data-bool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dest = btn.dataset.bool;
      const next = !isTruthy((L.values[dest] || [false])[0]);
      L.values[dest] = [next];
      paintArgs();
      schedulePreview();
    });
  });
  $$("[data-scalar]").forEach((sel) => {
    sel.addEventListener("change", () => {
      L.values[sel.dataset.scalar] = [sel.value];
      schedulePreview();
    });
  });
  $$("[data-chip]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const dest = inp.dataset.chip;
      const i = Number(inp.dataset.i);
      L.values[dest][i] = coerce(dest, inp.value);
      schedulePreview();
    });
  });
  $$("[data-sweep]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dest = btn.dataset.sweep;
      if (!L.values[dest]) L.values[dest] = [""];
      L.values[dest].push(defaultValue(L.spec.args.find((a) => a.dest === dest) || {}));
      paintArgs();
      schedulePreview();
    });
  });
  $$("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dest = btn.dataset.del;
      L.values[dest].splice(Number(btn.dataset.i), 1);
      if (!L.values[dest].length) L.values[dest] = [""];
      paintArgs();
      schedulePreview();
    });
  });
}

function paintOverrides() {
  const box = $("#overrides");
  if (!box) return;
  const L = state.launch;
  box.innerHTML = L.overrideRows
    .map(
      (row, i) => `<div class="env-row" style="grid-template-columns: 1fr 1.4fr auto">
        <input placeholder="model.lr" data-ov-key="${i}" value="${esc(row.key)}" />
        <div class="chips">${row.vals
          .map(
            (v, j) => `<span class="chip"><input data-ov-val="${i}" data-j="${j}" value="${esc(v)}" />
            ${row.vals.length > 1 ? `<button type="button" data-ov-del="${i}" data-j="${j}">×</button>` : ""}</span>`
          )
          .join("")}
          <button class="btn ghost small" type="button" data-ov-add="${i}">+</button>
        </div>
        <button class="btn ghost small" type="button" data-ov-rm="${i}">删</button>
      </div>`
    )
    .join("");
  $$("[data-ov-key]").forEach((inp) => {
    inp.addEventListener("input", () => {
      L.overrideRows[Number(inp.dataset.ovKey)].key = inp.value;
      schedulePreview();
    });
  });
  $$("[data-ov-val]").forEach((inp) => {
    inp.addEventListener("input", () => {
      L.overrideRows[Number(inp.dataset.ovVal)].vals[Number(inp.dataset.j)] = inp.value;
      schedulePreview();
    });
  });
  $$("[data-ov-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      L.overrideRows[Number(btn.dataset.ovAdd)].vals.push("");
      paintOverrides();
    });
  });
  $$("[data-ov-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = L.overrideRows[Number(btn.dataset.ovDel)];
      row.vals.splice(Number(btn.dataset.j), 1);
      if (!row.vals.length) row.vals = [""];
      paintOverrides();
      schedulePreview();
    });
  });
  $$("[data-ov-rm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      L.overrideRows.splice(Number(btn.dataset.ovRm), 1);
      paintOverrides();
      schedulePreview();
    });
  });
}

function paintEnv() {
  const L = state.launch;
  $("#env-rows").innerHTML = L.envRows
    .map(
      (row, i) => `<div class="env-row">
        <input placeholder="变量名" data-env-k="${i}" value="${esc(row.key)}" />
        <input placeholder="值" data-env-v="${i}" value="${esc(row.value)}" />
        <button class="btn ghost small" type="button" data-env-rm="${i}">删</button>
      </div>`
    )
    .join("");
  $$("[data-env-k]").forEach((inp) => inp.addEventListener("input", () => (L.envRows[Number(inp.dataset.envK)].key = inp.value)));
  $$("[data-env-v]").forEach((inp) => inp.addEventListener("input", () => (L.envRows[Number(inp.dataset.envV)].value = inp.value)));
  $$("[data-env-rm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      L.envRows.splice(Number(btn.dataset.envRm), 1);
      if (!L.envRows.length) L.envRows.push({ key: "", value: "" });
      paintEnv();
    });
  });
}

function isTruthy(v) {
  return v === true || v === "true" || v === "1" || v === 1;
}

function coerce(dest, raw) {
  const arg = state.launch.spec.args.find((a) => a.dest === dest);
  if (!arg) return raw;
  if (arg.type === "int" && raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  if (arg.type === "float" && raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  if (arg.type === "bool") return isTruthy(raw);
  return raw;
}

function collectPayload() {
  const L = state.launch;
  const { parts, params } = parseHash();
  const values = {};
  let sweep = false;
  for (const [k, arr] of Object.entries(L.values)) {
    const clean = arr.map((v) => (v === "" ? null : v)).filter((v) => v !== null && v !== undefined);
    if (!clean.length) continue;
    if (clean.length > 1) {
      values[k] = clean;
      sweep = true;
    } else values[k] = clean[0];
  }
  const override_dims = {};
  for (const row of L.overrideRows) {
    if (!row.key.trim()) continue;
    const vals = row.vals.map((v) => v.trim()).filter(Boolean);
    if (!vals.length) continue;
    if (vals.length > 1) {
      override_dims[row.key.trim()] = vals;
      sweep = true;
    } else override_dims[row.key.trim()] = vals[0];
  }
  const env = {};
  for (const row of L.envRows) {
    if (row.key.trim()) env[row.key.trim()] = row.value;
  }
  return {
    workspace_id: Number(parts[1]),
    script: params.get("script"),
    values,
    extra: L.extra,
    overrides: [],
    override_dims,
    env,
    gpu: (L.gpus || []).join(",") || null,
    gpu_policy: L.gpuPolicy || "pin",
    python: L.python || null,
    cwd: L.cwd || null,
    sweep,
  };
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => doPreview(false), 280);
}

async function doPreview(notify) {
  const payload = collectPayload();
  const hint = $("#combo-hint");
  try {
    const data = await api("/preview", { method: "POST", body: payload });
    const plans = data.plans || (data.commands || []).map((command) => ({ command, gpu: null }));
    $("#cmd-preview").textContent =
      plans
        .slice(0, 8)
        .map((p) => (p.gpu != null && p.gpu !== "" ? `[GPU ${p.gpu}] ${p.command}` : p.command))
        .join("\n\n") + (plans.length > 8 ? `\n\n… 共 ${plans.length} 条` : "");
    const gpus = [...new Set(plans.map((p) => p.gpu).filter((g) => g != null && g !== ""))];
    const bits = [];
    bits.push(payload.sweep ? `消融 ${data.count} 组` : "单次运行");
    if (gpus.length) bits.push(payload.gpu_policy === "spread" ? `轮转到 GPU ${gpus.join(",")}` : `CUDA_VISIBLE_DEVICES=${gpus.join(" / ")}`);
    bits.push(`同时最多 ${data.max_concurrent || state.settings.max_concurrent} 路`);
    if (hint) hint.textContent = bits.join(" · ");
    $("#launch").textContent = data.count > 1 ? `运行 × ${data.count}` : "运行";
    if (notify) {
      const box = $("#cmd-preview");
      if (box) box.scrollIntoView({ block: "nearest" });
    }
  } catch (err) {
    $("#cmd-preview").textContent = err.message;
    if (hint) hint.textContent = "";
    if (notify) toast(err.message);
  }
}

async function doLaunch() {
  const payload = collectPayload();
  const missing = (state.launch.spec.args || []).filter((arg) => {
    if (!arg.required) return false;
    const v = payload.values[arg.dest];
    return v === undefined || v === null || v === "";
  });
  if (missing.length) {
    toast(`缺少必填参数 ${missing.map((a) => a.name).join(", ")}`);
    return;
  }
  try {
    const data = await api("/jobs", { method: "POST", body: payload });
    toast(`已提交 ${data.count} 个任务${data.max_concurrent ? ` · 同时 ${data.max_concurrent} 路` : ""}`);
    location.hash = "#/jobs";
  } catch (err) {
    toast(err.message);
  }
}

async function savePreset() {
  const name = ($("#preset-name")?.value || "").trim();
  if (!name) {
    toast("先填一个预设名称");
    $("#preset-name")?.focus();
    return;
  }
  const payload = collectPayload();
  const { parts, params } = parseHash();
  try {
    await api("/presets", {
      method: "POST",
      body: {
        workspace_id: Number(parts[1]),
        script: params.get("script"),
        name,
        payload,
      },
    });
    toast("已保存预设");
    render();
  } catch (err) {
    toast(err.message);
  }
}

function applyPreset(id) {
  const L = state.launch;
  const preset = L.presets.find((p) => p.id === id);
  if (!preset) return;
  const p = preset.payload || {};
  for (const arg of L.spec.args || []) {
    const v = p.values?.[arg.dest];
    L.values[arg.dest] = Array.isArray(v) ? v : [v ?? defaultValue(arg)];
  }
  L.extra = p.extra || "";
  L.python = p.python || L.python;
  L.gpus = String(p.gpu || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  L.gpuPolicy = p.gpu_policy || (L.gpus.length > 1 ? "spread" : "pin");
  L.cwd = p.cwd || "";
  L.overrideRows = Object.entries(p.override_dims || {}).map(([key, val]) => ({
    key,
    vals: Array.isArray(val) ? val : [val],
  }));
  if (!L.overrideRows.length && L.spec.kind === "hydra") L.overrideRows = [{ key: "", vals: [""] }];
  L.envRows = Object.entries(p.env || {}).map(([key, value]) => ({ key, value }));
  if (!L.envRows.length) L.envRows.push({ key: "", value: "" });
  L.adjusted = [];
  $("#extra").value = L.extra;
  $("#python").value = L.python;
  $("#cwd").value = L.cwd;
  const pol = $(`[name=gpol][value="${L.gpuPolicy}"]`);
  if (pol) pol.checked = true;
  paintGpuPick();
  paintArgs();
  paintOverrides();
  paintEnv();
  schedulePreview();
  toast(`已套用 ${preset.name}`);
}

function stripAnsi(s) {
  return String(s)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}

function renderTerminal(raw) {
  return termString(termFromText(raw));
}

function termFromText(raw) {
  const term = createTerm();
  termWrite(term, raw);
  return term;
}

function lastLines(text, n) {
  const parts = String(text).split("\n");
  return parts.slice(-n).join("\n");
}

function createTerm() {
  return { lines: [], line: "", col: 0, replaceLine: false };
}

function termWrite(term, raw) {
  const s = stripAnsi(raw);
  for (const ch of s) {
    if (ch === "\r") {
      term.col = 0;
      term.replaceLine = true;
      continue;
    }
    if (ch === "\n") {
      term.lines.push(term.line);
      if (term.lines.length > 8000) term.lines.splice(0, term.lines.length - 6000);
      term.line = "";
      term.col = 0;
      term.replaceLine = false;
      continue;
    }
    if (ch === "\b") {
      term.col = Math.max(0, term.col - 1);
      continue;
    }
    if (term.replaceLine && term.col === 0) {
      term.line = "";
      term.replaceLine = false;
    }
    if (term.col < term.line.length) term.line = term.line.slice(0, term.col) + ch + term.line.slice(term.col + 1);
    else term.line += ch;
    term.col += 1;
  }
}

function termString(term) {
  return term.lines.concat(term.line).join("\n");
}

function elapsed(from, to) {
  if (!from) return "";
  const start = Date.parse(from);
  if (Number.isNaN(start)) return "";
  const end = to ? Date.parse(to) : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function jobCard(j) {
  const live = j.status === "running" || j.status === "queued";
  const dur =
    j.status === "running"
      ? elapsed(j.started_at)
      : j.started_at && j.finished_at
        ? elapsed(j.started_at, j.finished_at)
        : "";
  return `<div class="job">
    <span class="status ${esc(j.status)}">${STATUS[j.status] || j.status}</span>
    <a href="#/jobs/${esc(j.id)}" style="color:inherit;text-decoration:none;min-width:0">
      <div>${esc(j.script || "")} ${j.gpu != null && j.gpu !== "" ? `<span class="muted">GPU ${esc(j.gpu)}</span>` : ""} ${dur ? `<span class="muted">${dur}</span>` : ""}</div>
      <div class="cmd" title="${esc(j.command)}">${esc(j.command)}</div>
      ${
        j.tail
          ? `<div class="log-snip">${esc(lastLines(renderTerminal(j.tail), 4))}</div>`
          : ""
      }
      <div class="when">${esc(j.created_at || "")} · ${esc(j.id)}${j.pid ? " · pid " + esc(j.pid) : ""}</div>
    </a>
    <div class="row">
      ${live ? `<button class="btn danger small" data-stop="${esc(j.id)}">停止</button>` : ""}
      ${j.group_id && live ? `<button class="btn ghost small" data-stop-group="${esc(j.group_id)}">停整组</button>` : ""}
    </div>
  </div>`;
}

function bindStopButtons(root) {
  $$("[data-stop]", root).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await api(`/jobs/${btn.dataset.stop}/stop`, { method: "POST", body: {} });
        await refreshChrome();
      } catch (err) {
        toast(err.message);
      }
    });
  });
  $$("[data-stop-group]", root).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const data = await api("/jobs/batch-stop", { method: "POST", body: { group_id: btn.dataset.stopGroup } });
        toast(`已停 ${data.count} 个`);
        await refreshChrome();
      } catch (err) {
        toast(err.message);
      }
    });
  });
  $$("[data-stop-gpu]", root).forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        const data = await api("/jobs/batch-stop", { method: "POST", body: { gpu: String(btn.dataset.stopGpu) } });
        toast(`GPU ${btn.dataset.stopGpu} 已停 ${data.count} 个`);
        await refreshChrome();
      } catch (err) {
        toast(err.message);
      }
    });
  });
}

function paintJobBoard() {
  const board = $("#job-board");
  const occ = $("#occ");
  if (!board) return;
  const jobs = state.jobs || [];
  const running = jobs.filter((j) => j.status === "running");
  const queued = jobs.filter((j) => j.status === "queued");
  const done = jobs.filter((j) => j.status !== "running" && j.status !== "queued");
  const gpus = state.gpu?.gpus || [];
  if (occ) {
    if (gpus.length) {
      occ.innerHTML = `<div class="occ-grid">${gpus
          .map((g) => {
            const run = g.running || [];
            const q = g.queued || [];
            return `<div class="occ-card ${run.length ? "busy" : ""}">
              <div class="occ-head"><b>GPU ${g.index}</b> <span class="muted">${esc(g.name)}</span>
                ${run.length ? `<button class="btn danger small" data-stop-gpu="${g.index}">停此卡</button>` : ""}
              </div>
              ${
                run.length
                  ? run.map((j) => `<a href="#/jobs/${esc(j.id)}">${esc(j.script || j.id)} · pid ${esc(j.pid || "—")}</a>`).join("")
                  : `<div class="muted">空闲</div>`
              }
              ${q.length ? `<div class="muted">排队 ${q.length}</div>` : ""}
            </div>`;
          })
          .join("")}</div>`;
      bindStopButtons(occ);
    } else {
      occ.innerHTML = `<div class="occ-card">
        <div class="occ-head"><b>CPU 进程</b> <span class="muted">${esc(adapterLabel() || "无 CUDA")}</span></div>
        <div>运行中 ${running.length} · 排队 ${queued.length} · 同时最多 ${esc(state.settings.max_concurrent)} 路</div>
      </div>`;
    }
  }
  const section = (title, items) =>
    `<div class="panel" style="margin-bottom:16px"><h2>${title} · ${items.length}</h2>${
      items.length ? `<div class="job-list">${items.map(jobCard).join("")}</div>` : `<p class="muted">无</p>`
    }</div>`;
  board.innerHTML =
    section("运行中", running) +
    section("排队", queued) +
    (done.length ? section("最近完成", done.slice(0, 40)) : "");
  bindStopButtons(board);
}

async function renderJobs(view, token) {
  const data = await api("/jobs");
  if (isStale(token)) return;
  state.jobs = data.jobs || [];
  view.innerHTML = `
    <p class="kicker">运行记录</p>
    <div class="toolbar">
      <div>
        <h1>任务</h1>
        <p class="lede">这里能看到排队、正在跑、以及最近完成的进程。点进任务看 print / tqdm 日志。</p>
      </div>
      <div class="row">
        <label class="check" id="excl-jobs-wrap"><input type="checkbox" id="excl-jobs" ${state.settings.gpu_exclusive ? "checked" : ""} /> 同卡不叠</label>
        <label class="field" style="max-width:140px">同时运行
          <input id="conc" type="number" min="1" max="64" value="${esc(state.settings.max_concurrent)}" />
        </label>
        <button class="btn ghost small" id="stop-queued">清空排队</button>
        <button class="btn danger small" id="stop-running">停掉在跑</button>
      </div>
    </div>
    <div class="hint">
      <strong>这一页</strong>
      运行中的卡片会显示最近几行输出。点任务名称打开完整日志（进度条会在同一行刷新）。可停止单个、整组或全部在跑的进程。
    </div>
    <div id="occ"></div>
    <div id="job-board"></div>
  `;
  const exclWrap = $("#excl-jobs-wrap");
  if (exclWrap) exclWrap.hidden = !hasCuda();
  $("#conc").addEventListener("change", async (e) => {
    try {
      state.settings = await api("/settings", { method: "POST", body: { max_concurrent: Number(e.target.value) } });
      toast("并发已更新");
    } catch (err) {
      toast(err.message);
    }
  });
  const exclJobs = $("#excl-jobs");
  if (exclJobs) {
    exclJobs.addEventListener("change", async (e) => {
      try {
        state.settings = await api("/settings", { method: "POST", body: { gpu_exclusive: e.target.checked } });
      } catch (err) {
        toast(err.message);
      }
    });
  }
  $("#stop-queued").addEventListener("click", async () => {
    try {
      const data = await api("/jobs/batch-stop", { method: "POST", body: { status: "queued" } });
      toast(`已取消排队 ${data.count} 个`);
      await refreshChrome();
    } catch (err) {
      toast(err.message);
    }
  });
  $("#stop-running").addEventListener("click", async () => {
    if (!confirm("停止所有正在运行的进程？")) return;
    try {
      const data = await api("/jobs/batch-stop", { method: "POST", body: { status: "running" } });
      toast(`已停 ${data.count} 个`);
      await refreshChrome();
    } catch (err) {
      toast(err.message);
    }
  });
  paintJobBoard();
}

async function renderLog(view, jobId, token) {
  const job = await api(`/jobs/${jobId}`);
  if (isStale(token)) return;
  const live = job.status === "running" || job.status === "queued";
  view.innerHTML = `
    <p class="kicker"><a href="#/jobs">任务</a> / ${esc(String(job.id).slice(0, 8))}</p>
    <div class="toolbar">
      <div>
        <h1>${esc(job.script || "任务")}</h1>
        <p class="lede">${esc(job.command)}</p>
      </div>
      <div class="row">
        <span class="status ${esc(job.status)}" id="log-status">${STATUS[job.status] || job.status}</span>
        ${live ? `<button class="btn danger" id="stop">停止</button>` : ""}
        <button class="btn ghost small" id="copy-log">复制</button>
        <label class="check"><input type="checkbox" id="follow" checked /> 跟随</label>
        <a class="btn ghost" href="#/jobs">返回任务</a>
      </div>
    </div>
    <pre class="log-shell" id="log"></pre>
  `;
  const log = $("#log");
  const followBox = $("#follow");
  const term = createTerm();
  let follow = true;
  log.addEventListener("scroll", () => {
    follow = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    if (followBox) followBox.checked = follow;
  });
  if (followBox) {
    followBox.addEventListener("change", () => {
      follow = followBox.checked;
      if (follow) log.scrollTop = log.scrollHeight;
    });
  }
  const paint = () => {
    log.textContent = termString(term);
    if (follow) log.scrollTop = log.scrollHeight;
  };
  const applyStatus = (status) => {
    const el = $("#log-status");
    if (el && status) {
      el.className = `status ${status}`;
      el.textContent = STATUS[status] || status;
    }
    const btn = $("#stop");
    if (btn && status && status !== "running" && status !== "queued") btn.remove();
  };
  const stop = $("#stop");
  if (stop) {
    stop.addEventListener("click", async () => {
      try {
        const j = await api(`/jobs/${jobId}/stop`, { method: "POST", body: {} });
        applyStatus(j.status);
        if (j.status === "stopped") toast("已停止");
        else toast(STATUS[j.status] || "任务已结束");
        await refreshChrome();
      } catch (err) {
        toast(err.message);
      }
    });
  }
  $("#copy-log").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(termString(term));
      toast("已复制日志");
    } catch {
      toast("复制失败");
    }
  });
  const src = new EventSource(`/api/jobs/${jobId}/stream`);
  state.logSource = src;
  src.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.text) {
        termWrite(term, data.text);
        paint();
      }
      if (data.status) applyStatus(data.status);
      if (data.done) {
        src.close();
        refreshChrome();
      }
    } catch {
      termWrite(term, ev.data + "\n");
      paint();
    }
  };
  src.onerror = () => {
    /* browser retries; ignore */
  };
}

window.addEventListener("hashchange", render);
window.addEventListener("load", async () => {
  if (!location.hash || location.hash === "#") {
    history.replaceState(null, "", `${location.pathname}${location.search}#/`);
  }
  paintWsNav();
  await refreshChrome();
  await render();
  setInterval(refreshChrome, 4000);
});
