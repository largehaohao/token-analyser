import { describe, expect, it } from "vitest";
import type { PerformanceSummary } from "./api";
import { performanceCopy } from "./performance-copy";

const request = (over: Partial<PerformanceSummary> = {}): PerformanceSummary => ({
  taskCount: 12, ttftSampleCount: 4, speedSampleCount: 12,
  avgTtftMs: 1829.5, outputTokensPerSecond: 22.24, totalDurationMs: 12_000,
  requestDurationMs: 18_000, requestDurationCount: 12,
  taskDurationMs: 30_000, taskDurationCount: 1,
  basis: "request", ...over,
});

describe("performance panel copy", () => {
  it("labels request-based sessions as model requests, not agent tasks", () => {
    const copy = performanceCopy(request());
    expect(copy.speedLabel).toBe("请求平均 tok/s");
    expect(copy.durationLabel).toBe("耗时");
    expect(copy.requestDurationLabel).toBe("模型请求总时间");
    expect(copy.taskDurationLabel).toBe("任务完成总时间");
    expect(copy.ttftNote).toBe("请求发出到首 token · 4 次模型请求");
    expect(copy.speedNote).toBe("总输出 ÷ 总解码时长 · 12 次模型请求");
    expect(copy.requestDurationNote).toBe("各次模型请求时长合计 · 12 次模型请求");
    expect(copy.taskDurationNote).toBe("首个请求到末次请求结束 · 1 段会话");
    expect(copy.basisNote).toBe("统计口径：单次模型请求。");
  });

  it("states that tok/s is the decode rate and names the full-window fallback", () => {
    const copy = performanceCopy(request());
    expect(copy.note).toContain("输出 ÷ (请求时长 − TTFT)");
    expect(copy.note).toContain("解码速率");
    expect(copy.note).toContain("未记录 TTFT 的请求按整段请求时长计算");
    expect(copy.note).toContain("模型请求总时间是各次请求时长之和");
    expect(copy.note).toContain("与解码时长不同");
  });

  it("names the pi extension when a pi session recorded no first token", () => {
    const pi = performanceCopy(request({ ttftSampleCount: 0, avgTtftMs: null }), "pi");
    expect(pi.ttftNote).toContain("request-timing");
    // Other sources have no such switch, so their note stays generic.
    expect(performanceCopy(request({ ttftSampleCount: 0, avgTtftMs: null }), "cursor").ttftNote)
      .toBe("日志未记录首 token 时间（按请求口径统计）");
  });

  it("keeps the task wording for sources that record agent tasks", () => {
    const copy = performanceCopy({
      taskCount: 3, ttftSampleCount: 3, speedSampleCount: 3,
      avgTtftMs: 1200, outputTokensPerSecond: 50, totalDurationMs: 30_000,
      requestDurationMs: 8_000, requestDurationCount: 5,
      taskDurationMs: 30_000, taskDurationCount: 3,
      basis: "task",
    });
    expect(copy.speedLabel).toBe("任务平均 tok/s");
    expect(copy.durationLabel).toBe("耗时");
    expect(copy.requestDurationNote).toBe("各次模型请求时长合计 · 5 次模型请求");
    expect(copy.taskDurationNote).toBe("已完成任务耗时合计 · 3 次");
    expect(copy.ttftNote).toBe("任务开始到首 token · 3 次已完成任务");
    expect(copy.speedNote).toBe("总输出 ÷ 总耗时 · 3 次已完成任务");
    expect(copy.note).toContain("按整次任务计算");
    expect(copy.note).toContain("模型请求总时间只计各次请求本身");
  });

  it("states that a source records no request timing at all", () => {
    const copy = performanceCopy(request({
      ttftSampleCount: 0, speedSampleCount: 0, avgTtftMs: null, outputTokensPerSecond: null,
      totalDurationMs: null, requestDurationMs: null, requestDurationCount: 0,
      taskDurationMs: null, taskDurationCount: 0,
    }));
    expect(copy.speedNote).toBe("该来源未记录请求时长或输出 Token 数");
    expect(copy.requestDurationNote).toBe("该来源未记录请求时长");
    expect(copy.taskDurationNote).toBe("日志未记录会话起止时间");
  });

  it("defaults to the task wording when no samples exist", () => {
    const copy = performanceCopy({
      taskCount: 0, ttftSampleCount: 0, speedSampleCount: 0,
      avgTtftMs: null, outputTokensPerSecond: null, totalDurationMs: null,
      requestDurationMs: null, requestDurationCount: 0,
      taskDurationMs: null, taskDurationCount: 0,
      basis: null,
    });
    expect(copy.speedLabel).toBe("任务平均 tok/s");
    expect(copy.durationLabel).toBe("耗时");
    expect(copy.ttftNote).toBe("日志未记录首 token 时间");
    expect(copy.requestDurationNote).toBe("该来源未记录请求时长");
    expect(copy.taskDurationNote).toBe("暂无完整的任务耗时记录");
  });
});
