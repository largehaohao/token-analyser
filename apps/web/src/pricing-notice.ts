import type { ModelPricingUpdate, PricingSourceResult } from "./api";

export type PricingUpdateTone = "success" | "warning";

/** Which surfaces picked up the refreshed prices. */
export type PricingRefreshState = "all" | "detail" | "overview" | "none";

const SOURCE_LABEL = { codex: "Codex", qwen: "千问" } as const;

const RECALCULATION_COPY: Record<PricingRefreshState, string> = {
  all: "，并重新计算本地成本。",
  detail: "，成本总览与会话列表已更新，但当前会话明细刷新失败。",
  overview: "，成本总览已更新，但会话列表刷新失败。",
  none: "，但成本总览刷新失败，请重试。",
};

const FAILURE_COPY: Record<string, string> = {
  official_pricing_unavailable: "OpenAI 官网价格页无法访问",
  official_pricing_format_changed: "OpenAI 官网价格表格式已变化",
  qwen_pricing_unavailable: "千问官方价格页无法访问",
  qwen_pricing_format_changed: "千问官方价格表格式已变化",
  qwen_pricing_input_price_missing: "千问官方价格表缺少输入单价列",
  qwen_pricing_output_price_missing: "千问官方价格表缺少输出单价列",
  qwen_pricing_targets_missing: "本地千问价格配置缺少模型条目",
  qwen_pricing_fx_missing: "本地千问价格配置缺少人民币换算率",
  rate_card_read_failed: "Codex 价格配置读取失败",
  rate_card_write_failed: "Codex 价格配置写入失败",
  api_prices_read_failed: "千问价格配置读取失败",
  api_prices_write_failed: "千问价格配置写入失败",
};

export function pricingFailureCopy(status: string): string {
  return FAILURE_COPY[status] ?? status;
}

/**
 * One sentence covering both price sources: which rates arrived, which
 * publisher failed, and whether local costs were recalculated.
 */
export function pricingUpdateNotice(
  result: ModelPricingUpdate,
  refreshed: PricingRefreshState,
): { tone: PricingUpdateTone; message: string } {
  const recalculation = RECALCULATION_COPY[refreshed];

  const sources = [result.codex, result.qwen].filter(Boolean) as PricingSourceResult[];
  if (sources.length === 0) {
    return {
      tone: refreshed === "all" ? "success" : "warning",
      message: `已同步 ${result.modelCount} 种模型价格（${result.asOf}）${recalculation}`,
    };
  }

  const synced = (["codex", "qwen"] as const)
    .map((key) => [SOURCE_LABEL[key], result[key]] as const)
    .filter(([, source]) => source?.status === "ok")
    .map(([label, source]) => `${label} ${source!.modelCount ?? 0} 种`);
  const failed = (["codex", "qwen"] as const)
    .map((key) => [SOURCE_LABEL[key], result[key]] as const)
    .filter(([, source]) => source != null && source.status !== "ok")
    .map(([label, source]) => `${label}价格未更新（${pricingFailureCopy(source!.status)}）`);

  const asOf = (["codex", "qwen"] as const)
    .map((key) => result[key])
    .filter((source) => source?.status === "ok")
    .map((source) => source!.asOf!)
    .filter(Boolean)
    .sort()
    .at(-1);
  const tone: PricingUpdateTone =
    failed.length === 0 && refreshed === "all" ? "success" : "warning";

  if (synced.length === 0) {
    return { tone: "warning", message: `未同步到新的模型价格：${failed.join("、")}。` };
  }

  return {
    tone,
    message:
      `已同步 ${synced.join("与")}模型价格（${asOf}）` +
      (failed.length > 0 ? `，${failed.join("、")}，价格保持不变` : "") +
      recalculation,
  };
}
