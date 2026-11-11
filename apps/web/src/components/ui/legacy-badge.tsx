import { Badge as ShadcnBadge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";

/**
 * shadcn Badge for the app's existing pill classes.
 *
 * It keeps the Radix Slot / CVA semantics and the accessible focus states, but
 * opts out of Badge's own geometry (padding, full rounding, border, fixed font
 * size). styles.css stays authoritative, so a `.badge` that used to be plain
 * text stays plain text and `.badge.live` keeps its own padding and radius.
 */
export function LegacyBadge({
  className,
  variant = "outline",
  ...props
}: ComponentProps<typeof ShadcnBadge>) {
  return (
    <ShadcnBadge
      {...props}
      variant={variant}
      className={cn(
        "w-auto shrink gap-0 overflow-visible rounded-none border-0 bg-transparent p-0 font-normal whitespace-normal shadow-none transition-none",
        className,
      )}
    />
  );
}
