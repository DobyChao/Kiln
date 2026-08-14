import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { useKiln } from "../context/KilnContext";
import { STATUS } from "../lib/format";
import { createTerm, termString, termWrite } from "../lib/term";
import { Button, Empty, PageHeader, StatusBadge } from "../components/ui";

export default function JobLog() {
  const { jobId } = useParams();
  const { toast, refresh } = useKiln();
  const [job, setJob] = useState(null);
  const [status, setStatus] = useState("");
  const [logText, setLogText] = useState("");
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState("");
  const logRef = useRef(null);
  const termRef = useRef(createTerm());
  const followRef = useRef(true);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  useEffect(() => {
    const el = logRef.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [logText, follow]);

  useEffect(() => {
    let cancelled = false;
    const box = { src: null };
    termRef.current = createTerm();
    setLogText("");
    (async () => {
      try {
        const data = await api(`/jobs/${jobId}`);
        if (cancelled) return;
        setJob(data);
        setStatus(data.status);
        const src = new EventSource(`/api/jobs/${jobId}/stream`);
        box.src = src;
        src.onmessage = (ev) => {
          try {
            const payload = JSON.parse(ev.data);
            if (payload.text) {
              termWrite(termRef.current, payload.text);
              setLogText(termString(termRef.current));
            }
            if (payload.status) setStatus(payload.status);
            if (payload.done) {
              src.close();
              refresh();
            }
          } catch {
            termWrite(termRef.current, ev.data + "\n");
            setLogText(termString(termRef.current));
          }
        };
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
      box.src?.close();
    };
  }, [jobId, refresh]);

  if (error) return <Empty title="加载失败">{error}</Empty>;
  if (!job) return <p className="text-sm text-muted">加载中…</p>;

  const live = status === "running" || status === "queued";

  async function stop() {
    try {
      const j = await api(`/jobs/${jobId}/stop`, { method: "POST", body: {} });
      setStatus(j.status);
      if (j.status === "stopped") toast("已停止");
      else toast(STATUS[j.status] || "任务已结束");
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  }

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(termString(termRef.current));
      toast("已复制日志");
    } catch {
      toast("复制失败");
    }
  }

  return (
    <>
      <PageHeader
        kicker={
          <>
            <Link to="/jobs" className="text-muted underline-offset-2 hover:text-text hover:underline">
              任务
            </Link>
            {` / ${String(job.id).slice(0, 8)}`}
          </>
        }
        title={job.script || "任务"}
        lede={job.command}
        actions={
          <>
            <StatusBadge status={status} />
            {live ? (
              <Button variant="danger" onClick={stop}>
                停止
              </Button>
            ) : null}
            <Button size="sm" onClick={copyLog}>
              复制
            </Button>
            <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted">
              <input
                type="checkbox"
                className="w-auto"
                checked={follow}
                onChange={(e) => {
                  setFollow(e.target.checked);
                  if (e.target.checked && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
                }}
              />
              跟随
            </label>
            <Link
              to="/jobs"
              className="inline-flex items-center rounded-lg border border-line px-3 py-1.5 text-sm no-underline hover:bg-hover"
            >
              返回任务
            </Link>
          </>
        }
      />
      <pre
        ref={logRef}
        className="log-shell min-h-[62vh] overflow-auto rounded-xl border border-line bg-[#161410] px-4 py-4 font-mono text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-[#d9d2c5]"
        onScroll={() => {
          const el = logRef.current;
          if (!el) return;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          setFollow(atBottom);
        }}
      >
        {logText}
      </pre>
    </>
  );
}
