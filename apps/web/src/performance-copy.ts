import type { PerformanceBasis, PerformanceSummary } from "./api";

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

export function performanceCopy(performance: PerformanceSummary | undefined): PerformanceCopy {
  const basis: PerformanceBasis = performance?.basis ?? "task";
  const task = basis === "task";
  const ttft = performance?.avgTtftMs;
  const speed = performance?.outputTokensPerSecond;
  return {
    speedLabel: task ? "任务平均 tok/s" : "请求平均 tok/s",
    ttftNote: ttft == null
      ? task
        ? "日志未记录首 token 时间"
        : "日志未记录首 token 时间（按请求口径统计）"
      : task
        ? `任务开始到首 token · ${performance?.ttftSampleCount} 次已完成任务`
        : `请求开始到首 token · ${performance?.ttftSampleCount} 次模型请求`,
    speedNote: speed == null
      ? task
        ? "暂无完整的任务耗时与输出记录"
        : "该来源未记录请求时长或输出 Token 数"
      : task
        ? `总输出 ÷ 总耗时 · ${performance?.speedSampleCount} 次已完成任务`
        : `总输出 ÷ 请求时长 · ${performance?.speedSampleCount} 次模型请求`,
    basisNote: task ? "统计口径：整次 agent 任务。" : "统计口径：单次模型请求。",
    note: task
      ? "TTFT 为任务开始到首 token 的等待时间；tok/s 按整次任务计算，包含思考、工具执行与等待。"
      : "tok/s 按日志记录的单次模型请求时长计算，请求之间的工具执行与等待不计入；与任务口径不可直接比较。",
  };
}
