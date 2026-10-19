import { describe, expect, it } from "vitest";
import type { PerformanceSummary } from "./api";
import { performanceCopy } from "./performance-copy";

describe("performance panel copy", () => {
  it("labels request-based sessions as model requests, not agent tasks", () => {
    const copy = performanceCopy({
      taskCount: 12, ttftSampleCount: 0, speedSampleCount: 12,
      avgTtftMs: null, outputTokensPerSecond: 42.5, basis: "request",
    });
    expect(copy.speedLabel).toBe("请求平均 tok/s");
    expect(copy.ttftNote).toBe("日志未记录首 token 时间（按请求口径统计）");
    expect(copy.speedNote).toBe("总输出 ÷ 请求时长 · 12 次模型请求");
    expect(copy.basisNote).toBe("统计口径：单次模型请求。");
  });

  it("keeps the task wording for sources that record agent tasks", () => {
    const copy = performanceCopy({
      taskCount: 3, ttftSampleCount: 3, speedSampleCount: 3,
      avgTtftMs: 1200, outputTokensPerSecond: 50, basis: "task",
    });
    expect(copy.speedLabel).toBe("任务平均 tok/s");
    expect(copy.ttftNote).toBe("任务开始到首 token · 3 次已完成任务");
    expect(copy.speedNote).toBe("总输出 ÷ 总耗时 · 3 次已完成任务");
  });

  it("states that a source records no request timing at all", () => {
    const copy = performanceCopy({
      taskCount: 4, ttftSampleCount: 0, speedSampleCount: 0,
      avgTtftMs: null, outputTokensPerSecond: null, basis: "request",
    });
    expect(copy.speedNote).toBe("该来源未记录请求时长或输出 Token 数");
  });

  it("defaults to the task wording when no samples exist", () => {
    const copy = performanceCopy({
      taskCount: 0, ttftSampleCount: 0, speedSampleCount: 0,
      avgTtftMs: null, outputTokensPerSecond: null, basis: null,
    });
    expect(copy.speedLabel).toBe("任务平均 tok/s");
    expect(copy.ttftNote).toBe("日志未记录首 token 时间");
  });
});
