import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = fileURLToPath(new URL("../../../fixtures/native/", import.meta.url));

const sources = (page: Page) => page.getByRole("group", { name: "会话来源", exact: true });
async function seedNative(page: Page) {
  for (const source of ["claude", "cursor", "pi"]) {
    const response = await page.request.post("/import", {
      headers: { "Content-Type": "application/x-ndjson", "X-Filename": `${source}.jsonl` },
      data: readFileSync(path.join(fixtureDir, `${source}.jsonl`), "utf8"),
    });
    expect(response.ok()).toBe(true);
  }
}

test("source selection is visible for all providers", async ({ page }) => {
  await page.goto("/#sessions");
  const sources = page.getByRole("group", { name: "会话来源" });
  await expect(sources).toBeVisible();
  for (const label of ["所有来源", "Codex", "Claude Code", "Cursor", "pi"]) {
    await expect(sources.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
});

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
  await page.getByRole("group", { name: "会话来源", exact: true }).getByRole("button", { name: "所有来源", exact: true }).click();
  await page.locator("#session-search").fill("Claude Code");
  await expect(page.locator(".session-main")).toHaveCount(1);
  await page.getByRole("group", { name: "会话来源", exact: true }).getByRole("button", { name: "Cursor", exact: true }).click();
  await page.reload();
  await expect(page.locator(".session-kicker .badge", { hasText: "Cursor" })).toBeVisible();
});

test("every source filters the list and overview, and survives reload and browser back", async ({ page }) => {
  await seedNative(page);
  await page.goto("/#sessions");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  for (const [id, label] of [["codex", "Codex"], ["claude", "Claude Code"], ["cursor", "Cursor"], ["pi", "pi"]]) {
    await sources(page).getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator(".session-main").first()).toBeVisible();
    const badges = page.locator(".session-main .row-top .badge").filter({ hasText: new RegExp(`^${label}$`) });
    await expect.poll(async () => await badges.count() === await page.locator(".session-main").count()).toBe(true);
    await expect(page.locator(".session-kicker .badge", { hasText: new RegExp(`^${label}$`) })).toBeVisible();
    await page.getByRole("link", { name: "成本总览", exact: true }).click();
    const overview = await (await page.request.get(`/overview?source=${id}`)).json();
    await expect(page.getByRole("button", { name: /已分析会话/ })).toContainText(String(overview.sessionCount));
    await page.getByRole("link", { name: "会话明细", exact: true }).click();
  }
  await page.getByRole("searchbox", { name: "筛选会话" }).fill("unmatched query");
  await sources(page).getByRole("button", { name: "Claude Code", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "筛选会话" })).toHaveValue("");
  await page.reload();
  await expect(sources(page).getByRole("button", { name: "Claude Code", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".session-kicker .badge", { hasText: "Claude Code" })).toBeVisible();
  await sources(page).getByRole("button", { name: "Cursor", exact: true }).click();
  await expect(page.locator(".session-kicker .badge", { hasText: "Cursor" })).toBeVisible();
  await page.goBack();
  await expect(sources(page).getByRole("button", { name: "Claude Code", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".session-kicker .badge", { hasText: "Claude Code" })).toBeVisible();
});

test("historical sessions stay discoverable and missing sources explain how to import", async ({ page }) => {
  await seedNative(page);
  const { sessions } = await (await page.request.get("/sessions")).json();
  const historical = sessions.filter((s: { source: string }) => s.source !== "claude")
    .map((s: object) => ({ ...s, startedAt: "2020-01-01T00:00:00Z", lastEventAt: "2020-01-01T00:00:00Z" }));
  await page.route("**/sessions", (route) => route.fulfill({ json: { sessions: historical } }));
  await page.goto("/#sessions");
  await sources(page).getByRole("button", { name: "pi", exact: true }).click();
  await expect(page.locator(".source-range-notice")).toContainText("pi 已发现");
  await expect(page.locator(".session-main")).toHaveCount(0);
  await page.getByRole("button", { name: "查看全部时间", exact: true }).click();
  await expect(page.locator(".session-main").first()).toBeVisible();
  await sources(page).getByRole("button", { name: "Claude Code", exact: true }).click();
  await expect(page.locator(".session-list")).toContainText("未发现 Claude Code 会话记录");
  await expect(page.getByRole("button", { name: "选择文件", exact: true })).toBeEnabled();
});

test("changing sources rejects late overview data for the previous source", async ({ page }) => {
  const overview = await (await page.request.get("/overview")).json();
  let release!: () => void;
  let requested!: () => void;
  let fulfilled = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const request = new Promise<void>((resolve) => { requested = resolve; });
  await page.route("**/overview?**", async (route) => {
    if (!new URL(route.request().url()).searchParams.has("source")) {
      requested(); await gate;
      await route.fulfill({ json: { ...overview, sessionCount: 999 } });
      fulfilled = true;
    } else await route.fulfill({ json: { ...overview, sessionCount: 1 } });
  });
  await page.goto("/");
  await request;
  await sources(page).getByRole("button", { name: "pi", exact: true }).click();
  await expect(page.getByRole("button", { name: /已分析会话/ })).toContainText("1");
  release();
  await expect.poll(() => fulfilled).toBe(true);
  await expect(page.getByRole("button", { name: /已分析会话/ })).not.toContainText("999");
});

test("source controls remain visible and accessible on mobile", async ({ page }, testInfo) => {
  await seedNative(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/#sessions");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  for (const label of ["所有来源", "Codex", "Claude Code", "Cursor", "pi"]) {
    await expect(sources(page).getByRole("button", { name: label, exact: true })).toBeInViewport();
  }
  await sources(page).getByRole("button", { name: "Cursor", exact: true }).click();
  await expect(page.locator(".session-view")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(result.violations).toEqual([]);
  await page.locator(".source-toolbar").screenshot({ path: testInfo.outputPath("source-selector-mobile.png") });
});
