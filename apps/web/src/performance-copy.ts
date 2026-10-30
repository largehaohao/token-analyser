import type { PerformanceBasis, PerformanceSummary, SessionSource } from "./api";

/**
 * The performance panel must say what it measured: an agent task (Codex) or a
 * single model request (pi, Cursor, Claude). Mixing the two reads as speed.
 */
export type PerformanceCopy = {
  speedLabel: string;
  ttftNote: string;
  speedNote: string;
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
  return {
    speedLabel: task ? "任务平均 tok/s" : "请求平均 tok/s",
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
    basisNote: task ? "统计口径：整次 agent 任务。" : "统计口径：单次模型请求。",
    note: task
      ? "TTFT 为任务开始到首 token 的等待时间；tok/s 按整次任务计算，包含思考、工具执行与等待。"
      : "TTFT 为请求发出到首个输出 token 的等待时间；tok/s = 输出 ÷ (请求时长 − TTFT)，即解码速率；未记录 TTFT 的请求按整段请求时长计算。请求之间的工具执行与等待不计入。",
  };
}
