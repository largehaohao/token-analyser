import { formatAbsoluteTime, formatRelativeTime } from "./format";
import { useNow } from "./useNow";

export function RelativeTime({ iso }: { iso: string | null }) {
  const now = useNow();
  if (!iso) {
    return <span title={formatAbsoluteTime(iso)}>—</span>;
  }
  return (
    <time dateTime={iso} title={formatAbsoluteTime(iso)}>
      {formatRelativeTime(iso, now)}
    </time>
  );
}
