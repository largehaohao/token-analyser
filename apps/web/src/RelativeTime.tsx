import { formatAbsoluteTime, formatRelativeTime } from "./format";
import { useNow } from "./useNow";

export function RelativeTime({ iso }: { iso: string | null }) {
  const now = useNow();
  return (
    <span title={formatAbsoluteTime(iso)}>{formatRelativeTime(iso, now)}</span>
  );
}
