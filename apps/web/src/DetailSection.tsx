import type { ReactNode } from "react";

type Props = {
  title: string;
  description: string;
  children: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
};

export function DetailSection({
  title,
  description,
  children,
  open,
  onToggle,
}: Props) {
  return (
    <details
      className="detail-section"
      open={open}
      onToggle={
        onToggle ? (event) => onToggle(event.currentTarget.open) : undefined
      }
    >
      <summary>
        <span className="detail-section-heading">
          <span className="detail-section-title">{title}</span>
          <span className="detail-section-description">{description}</span>
        </span>
        <span className="detail-section-action" aria-hidden="true">
          <span className="detail-section-expand">展开</span>
          <span className="detail-section-collapse">收起</span>
          <span className="detail-section-chevron">⌄</span>
        </span>
      </summary>
      <div className="detail-section-body">{children}</div>
    </details>
  );
}
