import { useEffect, useState } from "react";
import { STATUS } from "../lib/format";

export function Button({
  variant = "ghost",
  size = "md",
  className = "",
  type = "button",
  ...props
}) {
  const variants = {
    solid: "border-ember bg-ember font-semibold text-white hover:brightness-110",
    ghost: "border-line bg-transparent text-text hover:bg-hover",
    danger: "border-bad/35 text-bad hover:bg-bad-soft",
  };
  const sizes = {
    sm: "px-2.5 py-1 text-xs",
    md: "px-3 py-1.5 text-sm",
  };
  return (
    <button
      type={type}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg border transition disabled:cursor-not-allowed disabled:opacity-45 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

export function Panel({ className = "", children }) {
  return (
    <div className={`rounded-xl border border-line bg-panel p-4 shadow-[0_1px_2px_rgba(0,0,0,.25)] ${className}`}>
      {children}
    </div>
  );
}

export function Field({ label, className = "", children }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 text-xs text-muted ${className}`}>
      {label}
      {children}
    </label>
  );
}

/** Local draft; commits a valid integer on blur / Enter. Empty and out-of-range values do not POST. */
export function CommitNumber({ value, min = 1, max = 64, onCommit, className = "", ...props }) {
  const [draft, setDraft] = useState(() => String(value ?? ""));

  useEffect(() => {
    setDraft(String(value ?? ""));
  }, [value]);

  function parse() {
    const n = Number(String(draft).trim());
    if (!Number.isInteger(n) || n < min || n > max) return null;
    return n;
  }

  async function commit() {
    const n = parse();
    if (n == null) {
      setDraft(String(value ?? ""));
      return;
    }
    if (n === value) return;
    try {
      await onCommit(n);
    } catch {
      setDraft(String(value ?? ""));
    }
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      spellCheck={false}
      className={className}
      value={draft}
      title={`${min}–${max}，输完后点别处或回车生效`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(String(value ?? ""));
          e.currentTarget.blur();
        }
      }}
      {...props}
    />
  );
}

export function Empty({ title, children }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-panel/40 px-5 py-10 text-center text-muted">
      {title && <strong className="mb-1.5 block text-base font-semibold text-text">{title}</strong>}
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function Hint({ title = "Tips", children, defaultOpen = false, className = "" }) {
  return (
    <details className={`group ${className || "mb-5"}`} open={defaultOpen}>
      <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded-full border border-line bg-panel py-1 pr-2.5 pl-1.5 text-[11px] font-medium text-muted select-none hover:border-ember/35 hover:text-text [&::-webkit-details-marker]:hidden">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-ember-soft font-mono text-[10px] font-semibold text-ember">
          ?
        </span>
        <span className="tracking-[0.16em] uppercase">{title}</span>
        <span className="text-[9px] text-muted/80 transition-transform group-open:rotate-180">▼</span>
      </summary>
      <div className="mt-2 max-w-2xl border-l-2 border-ember/50 py-0.5 pl-3.5 text-[13px] leading-relaxed text-muted [&_ol]:mt-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_ul]:mt-1.5 [&_ul]:list-disc [&_ul]:pl-4 [&_li+li]:mt-1.5 [&_p]:mt-1.5 [&_code]:rounded [&_code]:bg-hover [&_code]:px-1 [&_code]:text-text">
        {children}
      </div>
    </details>
  );
}

export function StatusBadge({ status }) {
  const styles = {
    queued: "bg-hover text-muted",
    running: "bg-ember-soft text-ember",
    succeeded: "bg-ok-soft text-ok",
    failed: "bg-bad-soft text-bad",
    stopped: "bg-warn-soft text-warn",
    interrupted: "bg-warn-soft text-warn",
  };
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${styles[status] || styles.queued}`}>
      {STATUS[status] || status}
    </span>
  );
}

export function PageHeader({ kicker, title, lede, actions, className = "" }) {
  return (
    <div className={`mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between ${className}`}>
      <div className="min-w-0">
        {kicker && <p className="mb-1 text-xs text-muted">{kicker}</p>}
        <h1 className="text-2xl font-semibold tracking-tight text-text sm:text-[1.75rem]">{title}</h1>
        {lede && <p className="mt-1 max-w-2xl break-all text-sm text-muted">{lede}</p>}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Badge({ children }) {
  return (
    <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] text-muted">{children}</span>
  );
}

export function Toggle({ on, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative h-[22px] w-10 shrink-0 rounded-full border ${
        on ? "border-ember bg-ember-soft" : "border-line bg-hover"
      }`}
      aria-pressed={on}
    >
      <i
        className={`absolute top-0.5 left-0.5 block h-4 w-4 rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-[18px] !bg-ember" : ""
        }`}
      />
    </button>
  );
}
