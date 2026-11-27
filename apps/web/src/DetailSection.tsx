import type { ReactNode } from "react";
import { Icon } from "./ui";

type Props = {
  title: string;
  description: string;
  children: ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  icon?: "sliders" | "shield";
  iconTone?: "brand" | "emerald";
};

export function DetailSection({
  title,
  description,
  children,
  open,
  onToggle,
  icon,
  iconTone = "brand",
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
          {icon && (
            <span className={`detail-section-icon is-${iconTone}`} aria-hidden="true">
              <Icon name={icon} />
            </span>
          )}
          <span className="detail-section-title">{title}</span>
          <span className="detail-section-description">{description}</span>
        </span>
        <span className="detail-section-action" aria-hidden="true">
          <span className="detail-section-chevron">
            <Icon name="chevron" />
          </span>
        </span>
      </summary>
      <div className="detail-section-body">{children}</div>
    </details>
  );
}
