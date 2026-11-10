import type { PerformanceBasis, PerformanceSummary, SessionSource } from "./api";

/**
 * The performance panel must say what it measured: an agent task (Codex) or a
 * single model request (pi, Cursor, Claude). Mixing the two reads as speed.
 */
export type PerformanceCopy = {
  speedLabel: string;
  durationLabel: string;
  requestDurationLabel: string;
  taskDurationLabel: string;
  ttftNote: string;
  speedNote: string;
  requestDurationNote: string;
  taskDurationNote: string;
  basisNote: string;
  note: string;
};

/**
 * `source` sharpens the copy where one source can record more than another:
 * pi logs the first-token instant only through the request-timing extension,
 * so a pi session without it says how that measurement becomes available
 * instead of reading as a generic gap.
 */
export function performanceCopy(
  performance: PerformanceSummary | undefined,
  source?: SessionSource,
): PerformanceCopy {
  const basis: PerformanceBasis = performance?.basis ?? "task";
  const task = basis === "task";
  const ttft = performance?.avgTtftMs;
  const speed = performance?.outputTokensPerSecond;
  const requestDuration = performance?.requestDurationMs ?? null;
  const taskDuration = performance?.taskDurationMs ?? null;
  const requestCount = performance?.requestDurationCount ?? 0;
  const taskCount = performance?.taskDurationCount ?? 0;
  return {
    speedLabel: task ? "任务平均 tok/s" : "请求平均 tok/s",
    durationLabel: "耗时",
    requestDurationLabel: "模型请求总时间",
    taskDurationLabel: "任务完成总时间",
    ttftNote: ttft == null
      ? task
        ? "日志未记录首 token 时间"
        : source === "pi"
          ? "日志未记录首 token 时间 · 启用 pi request-timing 扩展后新请求会记录"
          : "日志未记录首 token 时间（按请求口径统计）"
      : task
        ? `任务开始到首 token · ${performance?.ttftSampleCount} 次已完成任务`
        : `请求发出到首 token · ${performance?.ttftSampleCount} 次模型请求`,
    speedNote: speed == null
      ? task
        ? "暂无完整的任务耗时与输出记录"
        : "该来源未记录请求时长或输出 Token 数"
      : task
        ? `总输出 ÷ 总耗时 · ${performance?.speedSampleCount} 次已完成任务`
        : `总输出 ÷ 总解码时长 · ${performance?.speedSampleCount} 次模型请求`,
    requestDurationNote: requestDuration == null
      ? "该来源未记录请求时长"
      : `各次模型请求时长合计 · ${requestCount} 次模型请求`,
    taskDurationNote: taskDuration == null
      ? task
        ? "暂无完整的任务耗时记录"
        : "日志未记录会话起止时间"
      : task
        ? `已完成任务耗时合计 · ${taskCount} 次`
        : `首个请求到末次请求结束 · ${taskCount} 段会话`,
    basisNote: task ? "统计口径：整次 agent 任务。" : "统计口径：单次模型请求。",
    note: task
      ? "TTFT 为任务开始到首 token 的等待时间；tok/s 按整次任务计算，包含思考、工具执行与等待。模型请求总时间只计各次请求本身，不含工具与等待。"
      : "TTFT 为请求发出到首个输出 token 的等待时间；tok/s = 输出 ÷ (请求时长 − TTFT)，即解码速率；未记录 TTFT 的请求按整段请求时长计算。没有输出也没有首 token 的失败请求不计入；首 token 之后 20ms 内就把全文吐出的请求也不是解码速率。模型请求总时间是各次请求时长之和，与解码时长不同；任务完成总时间是首个请求到末次请求结束，含请求之间的工具执行与等待。",
  };
}
