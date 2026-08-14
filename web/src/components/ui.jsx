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

export function Empty({ title, children }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-panel/40 px-5 py-10 text-center text-muted">
      {title && <strong className="mb-1.5 block text-base font-semibold text-text">{title}</strong>}
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function Hint({ title, children, defaultOpen = false }) {
  return (
    <details
      className="mb-5 rounded-xl border border-ember/25 bg-ember-soft/70 px-4 py-3 text-sm"
      open={defaultOpen}
    >
      <summary className="cursor-pointer select-none font-medium text-text">{title}</summary>
      <div className="mt-2 text-muted [&_ol]:mt-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_code]:rounded [&_code]:bg-hover [&_code]:px-1">
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

export function PageHeader({ kicker, title, lede, actions }) {
  return (
    <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
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
