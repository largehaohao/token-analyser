import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

type IconName =
  | "overview"
  | "sessions"
  | "search"
  | "close"
  | "upload"
  | "arrow"
  | "clock"
  | "shield"
  | "warning"
  | "check"
  | "refresh"
  | "chevron";

const ICON_PATHS: Record<IconName, string> = {
  overview: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  sessions: "M8 4h12v14H8zM4 8v12h12M11 8h6M11 12h6",
  search: "M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  close: "M6 6l12 12M6 18 18 6",
  upload: "M12 16V3M7 8l5-5 5 5M4 15v5h16v-5",
  arrow: "M4 12h16M14 6l6 6-6 6",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  shield: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6zM8 12l3 3 5-6",
  warning: "M12 3 2 20h20L12 3zM12 9v5M12 17v.5",
  check: "M5 12l4 4L19 6",
  refresh:
    "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1",
  chevron: "M9 5l7 7-7 7",
};

export function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export function LedgerMark() {
  return (
    <svg
      className="ledger-mark"
      width="36"
      height="36"
      viewBox="0 0 36 36"
      aria-hidden="true"
    >
      <path
        d="M9 10v16M15 16v10M21 7v19M27 13v13"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  emphasis?: "solid" | "outline" | "ghost";
  intent?: "brand" | "neutral" | "danger";
  busy?: boolean;
};

export function Button({
  emphasis = "outline",
  intent = "neutral",
  busy = false,
  disabled,
  className = "",
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`button button-${emphasis} button-${intent} ${className}`}
    >
      <span className="button-label">{children}</span>
      {busy && <span className="button-spinner spinner" aria-hidden="true" />}
    </button>
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className = "",
}: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      className={`segmented-control ${className}`}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          className={option.id === value ? "active" : ""}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function StatePanel({
  kind,
  title,
  description,
  children,
  compact = false,
}: {
  kind: "loading" | "empty" | "error" | "missing";
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`state-panel state-${kind}${compact ? " state-compact" : ""}`}
      aria-busy={kind === "loading" || undefined}
    >
      <div className="state-symbol" aria-hidden="true">
        {kind === "loading" ? (
          <span className="spinner" />
        ) : (
          <Icon name={kind === "error" ? "warning" : "sessions"} />
        )}
      </div>
      <div role={kind === "error" ? "alert" : "status"} aria-atomic="true">
        {compact ? (
          <h3 className="state-title">{title}</h3>
        ) : (
          <h1 className="state-title" tabIndex={-1}>
            {title}
          </h1>
        )}
        {description && <p className="state-description">{description}</p>}
      </div>
      {children && <div className="state-actions">{children}</div>}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
  action,
}: {
  tone?: "info" | "warning" | "error" | "success";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`}>
      <Icon
        name={
          tone === "success" ? "check" : tone === "info" ? "refresh" : "warning"
        }
      />
      <div
        className="notice-copy"
        role={tone === "error" ? "alert" : "status"}
        aria-atomic="true"
      >
        {children}
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}

export function SearchField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (query: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const composing = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!composing.current) setDraft(value);
  }, [value]);

  function clear() {
    composing.current = false;
    setDraft("");
    onChange("");
    inputRef.current?.focus();
  }

  return (
    <form
      className="search-field"
      role="search"
      aria-label="会话搜索"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!composing.current) onChange(draft);
      }}
    >
      <label className="visually-hidden" htmlFor={id}>
        筛选会话
      </label>
      <Icon name="search" />
      <input
        ref={inputRef}
        id={id}
        className="session-search"
        type="search"
        value={draft}
        autoComplete="off"
        spellCheck={false}
        placeholder="搜索会话、目录或模型"
        aria-keyshortcuts="Control+k Meta+k"
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          onChange(event.currentTarget.value);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          if (!composing.current) onChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            clear();
          }
        }}
      />
      {draft && (
        <Button
          emphasis="ghost"
          className="search-clear"
          aria-label="清除会话搜索"
          onClick={clear}
        >
          <Icon name="close" />
        </Button>
      )}
    </form>
  );
}
