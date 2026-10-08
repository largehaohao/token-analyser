import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = fileURLToPath(new URL("../../../fixtures/native/", import.meta.url));

test("Claude, pi and Cursor imports show source, response, pricing basis and missing usage", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "会话明细" }).click();
  await page.getByRole("button", { name: "全部", exact: true }).click();
  for (const [source, label] of [["claude", "Claude Code"], ["pi", "pi"], ["cursor", "Cursor"]]) {
    await page.getByLabel("选择会话 JSONL 文件").setInputFiles({
      name: `${source}.jsonl`, mimeType: "application/x-ndjson",
      buffer: Buffer.from(readFileSync(path.join(fixtureDir, `${source}.jsonl`), "utf8")),
    });
    await expect(page.locator("#import-feedback")).toContainText(`已导入 ${source}.jsonl`);
    await expect(page.locator(".session-kicker .badge", { hasText: label })).toBeVisible();
    if (source === "cursor") {
      await expect(page.locator(".session-view .banner")).toContainText("token 用量未记录");
      await expect(page.locator(".headline-main .headline-value").first()).toHaveText("—");
    } else {
      await expect(page.locator(".headline-main .headline-value").first()).toHaveText("360");
    }
    await page.locator(".turn-expand").first().click();
    await expect(page.locator(".turn-detail")).toContainText("README reviewed.");
    if (source === "claude") await expect(page.getByLabel("Token 单价")).toContainText("USD");
    if (source === "pi") await expect(page.locator(".turn-detail")).toContainText("日志费用");
    if (source === "cursor") await expect(page.locator(".turn-detail")).toContainText("用量未记录");
  }
  await page.locator("#session-search").fill("Claude Code");
  await expect(page.locator(".session-main")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".session-kicker .badge", { hasText: "Cursor" })).toBeVisible();
});
