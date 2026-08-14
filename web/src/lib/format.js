export const STATUS = {
  queued: "排队",
  running: "运行中",
  succeeded: "完成",
  failed: "失败",
  stopped: "已停",
  interrupted: "中断",
};

export function elapsed(from, to) {
  if (!from) return "";
  const start = Date.parse(from);
  if (Number.isNaN(start)) return "";
  const end = to ? Date.parse(to) : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

export function hasCuda(gpu) {
  return !!(gpu?.cuda || (gpu?.gpus || []).length);
}

export function adapterLabel(gpu) {
  const adapters = gpu?.adapters || [];
  return adapters[0] || "";
}

export function rememberWorkspace(id, name) {
  if (!id) return;
  sessionStorage.setItem("kiln-ws-id", String(id));
  if (name) sessionStorage.setItem("kiln-ws-name", name);
}

export function readWorkspaceNav() {
  const id = sessionStorage.getItem("kiln-ws-id");
  const name = sessionStorage.getItem("kiln-ws-name") || "当前项目";
  return id ? { id, name } : null;
}

export function clearWorkspaceNav() {
  sessionStorage.removeItem("kiln-ws-id");
  sessionStorage.removeItem("kiln-ws-name");
}
