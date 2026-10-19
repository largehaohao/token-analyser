import { describe, expect, it } from "vitest";
import { pricingFailureCopy, pricingUpdateNotice } from "./pricing-notice";

describe("pricing update notice", () => {
  it("keeps the single-source sentence when the engine predates Qwen rates", () => {
    expect(
      pricingUpdateNotice({ asOf: "2026-09-23", modelCount: 13 }, "all"),
    ).toEqual({
      tone: "success",
      message: "已同步 13 种模型价格（2026-09-23），并重新计算本地成本。",
    });

    expect(
      pricingUpdateNotice({ asOf: "2026-09-23", modelCount: 13 }, "overview"),
    ).toEqual({
      tone: "warning",
      message:
        "已同步 13 种模型价格（2026-09-23），成本总览已更新，但会话列表刷新失败。",
    });
  });

  it("names both sources when both refresh", () => {
    expect(
      pricingUpdateNotice(
        {
          asOf: "2026-10-19",
          modelCount: 13,
          codex: { status: "ok", asOf: "2026-10-19", modelCount: 13 },
          qwen: { status: "ok", asOf: "2026-10-18", modelCount: 1 },
        },
        "all",
      ),
    ).toEqual({
      tone: "success",
      message:
        "已同步 Codex 13 种与千问 1 种模型价格（2026-10-19），并重新计算本地成本。",
    });
  });

  it("keeps the fetched rates and explains the source that failed", () => {
    const partial = pricingUpdateNotice(
      {
        asOf: "",
        modelCount: 0,
        codex: { status: "official_pricing_unavailable" },
        qwen: { status: "ok", asOf: "2026-10-19", modelCount: 1 },
      },
      "all",
    );
    expect(partial.tone).toBe("warning");
    expect(partial.message).toBe(
      "已同步 千问 1 种模型价格（2026-10-19），Codex价格未更新（OpenAI 官网价格页无法访问），价格保持不变，并重新计算本地成本。",
    );
  });

  it("reports that nothing was synchronized when both sources failed", () => {
    expect(
      pricingUpdateNotice(
        {
          asOf: "",
          modelCount: 0,
          codex: { status: "official_pricing_unavailable" },
          qwen: { status: "qwen_pricing_format_changed" },
        },
        "all",
      ),
    ).toEqual({
      tone: "warning",
      message:
        "未同步到新的模型价格：Codex价格未更新（OpenAI 官网价格页无法访问）、千问价格未更新（千问官方价格表格式已变化）。",
    });
  });

  it("falls back to the raw engine code for unlisted failures", () => {
    expect(pricingFailureCopy("api_prices_write_failed")).toBe(
      "千问价格配置写入失败",
    );
    expect(pricingFailureCopy("brand_new_code")).toBe("brand_new_code");
  });
});
