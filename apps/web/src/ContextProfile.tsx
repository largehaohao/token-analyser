import type { ContextBucket, ContextProfile as Profile } from "./api";
import { formatCompactTokens } from "./format";

export type ContextBucketId = "tools" | "skills";

const LABELS: Record<ContextBucketId, string> = {
  tools: "工具",
  skills: "技能",
};

const EMPTY: Record<ContextBucketId, string> = {
  tools: "该会话未记录工具 schema。Codex 核心工具（exec 等）通常不写入 JSONL。",
  skills: "该会话未记录技能目录。",
};

type Props = {
  profile: Profile;
  open: ContextBucketId | null;
  onOpen: (id: ContextBucketId | null) => void;
};

function BucketPanel({
  id,
  bucket,
  open,
  onToggle,
}: {
  id: ContextBucketId;
  bucket: ContextBucket;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`context-bucket ${open ? "open" : ""}`}>
      <button
        type="button"
        className="context-bucket-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="context-bucket-label">{LABELS[id]}</span>
        <span className="context-bucket-size">
          {bucket.items.length} 项 · {formatCompactTokens(bucket.chars)} 字符
        </span>
      </button>
      {open &&
        (bucket.items.length === 0 ? (
          <p className="context-empty">{EMPTY[id]}</p>
        ) : (
          <ul className="context-items">
            {bucket.items.map((item) => (
              <li key={`${id}-${item.name}-${item.source ?? ""}`}>
                <div className="context-item-top">
                  <span className="context-item-name">{item.name}</span>
                  <span className="context-item-chars">
                    {item.chars.toLocaleString("en-US")}
                  </span>
                </div>
                {item.source && (
                  <div className="context-item-source">{item.source}</div>
                )}
                {item.description && (
                  <div className="context-item-desc">{item.description}</div>
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

export function ContextProfileCard({ profile, open, onOpen }: Props) {
  function toggle(id: ContextBucketId) {
    onOpen(open === id ? null : id);
  }

  return (
    <section className="chart-card context-card" data-testid="context-card">
      <h3>上下文组成</h3>
      <p className="chart-desc">
        点击工具或技能，查看注入上下文由哪些条目组成。长度为字符数，不是账单
        token。
      </p>
      <div className="context-buckets">
        <BucketPanel
          id="tools"
          bucket={profile.tools}
          open={open === "tools"}
          onToggle={() => toggle("tools")}
        />
        <BucketPanel
          id="skills"
          bucket={profile.skills}
          open={open === "skills"}
          onToggle={() => toggle("skills")}
        />
      </div>
    </section>
  );
}
