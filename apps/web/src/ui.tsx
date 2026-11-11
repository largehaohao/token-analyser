import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  FilterIcon,
  GaugeIcon,
  InfoIcon,
  LayersIcon,
  LayoutGridIcon,
  PanelsTopLeftIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  UploadIcon,
  XIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button as ShadcnButton } from "@/components/ui/button";
import { Card as ShadcnCard } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

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
  | "chevron"
  | "info"
  | "filter"
  | "back"
  | "layers"
  | "gauge"
  | "power";

/** shadcn ships lucide-react; the STRATA icon vocabulary maps onto it. */
const ICONS: Record<IconName, LucideIcon> = {
  overview: LayoutGridIcon,
  sessions: PanelsTopLeftIcon,
  search: SearchIcon,
  close: XIcon,
  upload: UploadIcon,
  arrow: ArrowRightIcon,
  clock: ClockIcon,
  shield: ShieldCheckIcon,
  warning: TriangleAlertIcon,
  check: CheckIcon,
  refresh: RefreshCwIcon,
  chevron: ChevronRightIcon,
  info: InfoIcon,
  filter: FilterIcon,
  back: ArrowLeftIcon,
  layers: LayersIcon,
  gauge: GaugeIcon,
  power: ZapIcon,
};

export function Icon({
  name,
  className = "",
}: {
  name: IconName;
  className?: string;
}) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      className={cn("icon size-4.5", className)}
      size={18}
      strokeWidth={1.7}
      aria-hidden="true"
    />
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

/**
 * Legacy button recipe on top of the shadcn Button (Radix Slot + CVA).
 * The `button-*` classes stay so styles.css keeps ownership of the appearance.
 */
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
  const variant =
    intent === "danger"
      ? "destructive"
      : emphasis === "solid"
        ? "default"
        : emphasis === "ghost"
          ? "ghost"
          : intent === "brand"
            ? "outline"
            : "secondary";
  return (
    <ShadcnButton
      {...props}
      type={type}
      variant={variant}
      size="sm"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cn(`button button-${emphasis} button-${intent}`, className)}
    >
      <span className="button-label">{children}</span>
      {busy && <span className="button-spinner spinner" aria-hidden="true" />}
    </ShadcnButton>
  );
}

/**
 * shadcn Button for the app's "bare" controls (tree rows, session cards, rank
 * rows, inspectors). It keeps Radix Slot / CVA / data-slot semantics and the
 * accessible disabled + focus states, but opts out of the layout utilities
 * (height, gap, padding, nowrap, background) so styles.css stays authoritative
 * and no 320px overflow is introduced.
 */
export function BareButton({
  className,
  ...props
}: ComponentProps<typeof ShadcnButton>) {
  return (
    <ShadcnButton
      {...props}
      variant="ghost"
      className={cn(
        "inline-block h-auto min-h-0 w-auto shrink gap-0 whitespace-normal rounded-none bg-transparent p-0 font-normal shadow-none focus-visible:ring-0",
        className,
      )}
    />
  );
}

/**
 * shadcn Card supplies the component semantics; the neutraliser keeps legacy
 * surfaces on their own layout recipe (no forced flex column / 24px gaps).
 */
export function Panel({
  className,
  ...props
}: ComponentProps<typeof ShadcnCard>) {
  return (
    <ShadcnCard
      className={cn(
        "block gap-0 rounded-none border-0 py-0 shadow-none",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Accessible tabular data for chart surfaces. The visual chart is decorative;
 * the numbers stay readable by assistive tech and searchable.
 */
export function srTable(
  caption: string,
  headers: string[],
  rows: (string | number)[][],
) {
  return (
    <table className="visually-hidden">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {headers.map((header) => (
            <th key={header} scope="col">
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * shadcn Toggle (Radix) keeps the native <button aria-pressed> contract that
 * the segmented-control UX rules require. ToggleGroup is deliberately not used:
 * Radix renders its single-select variant as radiogroup/radio instead.
 */
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
        <Toggle
          key={option.id}
          variant="outline"
          size="sm"
          pressed={option.id === value}
          onPressedChange={() => onChange(option.id)}
          className={option.id === value ? "active" : ""}
        >
          {option.label}
        </Toggle>
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
    <Panel
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
    </Panel>
  );
}

/** shadcn Alert, with the notice's own live-region role kept on `.notice-copy`. */
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
    <Alert
      variant={tone === "error" ? "destructive" : "default"}
      role={undefined}
      className={`notice notice-${tone}`}
    >
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
    </Alert>
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
      <Label className="visually-hidden" htmlFor={id}>
        筛选会话
      </Label>
      <Icon name="search" />
      <Input
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
