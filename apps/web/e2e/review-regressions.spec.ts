import { test, expect, type Page } from "@playwright/test";
import type { Cost, Overview, SessionSnapshot } from "../src/api";

function cost(raw: number): Cost {
  return { raw, uncached_input: raw / 4, cached_input: raw / 4, output: raw / 2, credits: raw / 100, usd: raw / 1000 };
}

function overview(raw = 200): Overview {
  return {
    sessionCount: 1, turnCount: 5, live: false, collecting: false, watchPath: "/tmp/review",
    rateCardAsOf: "2026-08-27", cost: cost(raw), waste: cost(0), unpricedRaw: 0,
    days: [
      { date: "2026-10-20", cost: cost(200), flaggedCost: cost(100), unpricedRaw: 0 },
      { date: "2026-10-21", cost: cost(100), flaggedCost: cost(50), unpricedRaw: 0 },
    ], slices: [], models: [],
    performance: { taskCount: 5, ttftSampleCount: 2, speedSampleCount: 1, avgTtftMs: 500, outputTokensPerSecond: 5, basis: "request" },
    performanceDistribution: { ttft: [2, 0, 0, 0, 0], tps: [1, 0, 0, 0, 0], sampleCount: 5 },
  };
}

async function mockOverview(page: Page, data: Overview) {
  await page.route((url) => url.pathname === "/overview", (route) => route.fulfill({ json: data }));
  await page.goto("/#overview");
  await expect(page.getByTestId("overview-page")).toBeVisible();
}

for (const width of [1920, 1440, 1180, 960, 781, 780, 390, 320]) {
  test(`session list and detail remain separate before and after scrolling at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#sessions");
    if (width <= 780) await page.getByRole("button", { name: "展开筛选", exact: true }).click();
    await page.getByRole("button", { name: "全部", exact: true }).click();
    const sidebar = page.getByRole("complementary", { name: "会话列表", exact: true });
    const detail = page.getByRole("main", { name: "会话详情", exact: true });
    await expect(page.locator(".session-main").first()).toBeVisible();
    if (width <= 780) await page.locator(".session-main").first().click();
    await expect(page.locator(".session-view")).toBeVisible();

    if (width > 780) {
      const expectSeparateColumns = async () => {
        const listBox = await sidebar.boundingBox();
        const detailBox = await detail.boundingBox();
        expect(listBox).not.toBeNull();
        expect(detailBox!.x).toBeGreaterThanOrEqual(listBox!.x + listBox!.width);
        expect(detailBox!.x + detailBox!.width).toBeLessThanOrEqual(width);
        const headingBox = await page.locator(".sess-head").boundingBox();
        expect(headingBox!.x).toBeGreaterThanOrEqual(listBox!.x + listBox!.width);
      };
      await expectSeparateColumns();
      await page.evaluate(() => window.scrollTo(0, 450));
      await expectSeparateColumns();
      const sidebarScroll = await sidebar.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return el.scrollTop;
      });
      expect(sidebarScroll).toBeGreaterThan(0);
      await expectSeparateColumns();
      await expect(page.getByRole("button", { name: "返回会话列表", exact: true })).toBeHidden();
    } else {
      await expect(sidebar).toBeHidden();
      const detailBox = await detail.boundingBox();
      expect(detailBox!.x).toBeGreaterThanOrEqual(0);
      expect(detailBox!.x + detailBox!.width).toBeLessThanOrEqual(width);
      await page.getByRole("button", { name: "返回会话列表", exact: true }).click();
      await expect(sidebar).toBeVisible();
      await expect(detail).toBeHidden();
      const listBox = await sidebar.boundingBox();
      expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(width);
    }
    if (width === 1920 || width === 390) {
      await page.screenshot({ path: testInfo.outputPath(`session-layout-${width}.png`), fullPage: true });
    }
  });
}

test("ledger and composition preserve percentages, unpriced overlap, and USD costs", async ({ page }) => {
  const data = overview();
  data.cost = { ...data.cost, credits: null, usd: 10 };
  data.unpricedRaw = 100;
  await mockOverview(page, data);
  const cache = page.locator(".ledger-item").filter({ has: page.locator(".ledger-label", { hasText: "缓存命中" }) });
  await expect(cache.locator(".ledger-value")).toHaveText("50.0%");
  const money = page.locator(".ledger-item").filter({ has: page.locator(".ledger-label", { hasText: "预估费用" }) });
  await expect(money).toContainText("$10.00");
  await expect(money).toContainText("USD");
  await expect(page.locator(".comp-rows .comp-pct")).toHaveText(["50.0%", "50.0%"]);
  await expect(page.getByTestId("composition-panel")).toContainText("100");
  await expect(page.getByTestId("composition-panel")).toContainText("已包含在输入和输出中");
  await expect(page.locator(".hist-head .c")).toHaveText([
    /2\/5 轮有记录/, /1\/5 轮有记录/,
  ]);
});

for (const scope of ["source", "range"] as const) {
  test(`${scope} switches never compare against a different scope's previous window`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === "/overview", async (route) => {
      const url = new URL(route.request().url());
      const changed = scope === "source" ? url.searchParams.get("source") === "pi" : url.searchParams.get("days") === "2";
      const previous = url.searchParams.has("until");
      if (changed && previous) await gate;
      await route.fulfill({ json: overview(changed ? (previous ? 400 : 200) : 100) });
    });
    await page.goto("/#overview");
    const comparison = page.locator(".ledger-delta").first();
    await expect(comparison).toContainText("0%");
    try {
      if (scope === "source") {
        await page.getByRole("group", { name: "会话来源", exact: true }).getByRole("button", { name: "pi", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "5小时", exact: true }).click();
      }
      await expect(page.locator(".ledger-value").first()).toContainText("200");
      await expect(comparison).toContainText("—");
    } finally { release(); }
    await expect(comparison).toContainText("▼ 50%");
  });
}

test("sidebar sessions navigate and every turn value matches its header", async ({ page }) => {
  await page.goto("/#overview");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  const rank = page.locator(".rail-rank").first();
  await expect(rank).toBeVisible();
  await rank.click();
  await expect(page.locator(".session-view")).toBeVisible();
  await expect(page).toHaveURL(/#sessions$/);
  const sessionId = await page.locator(".session-reference").getAttribute("title");
  const snapshot: SessionSnapshot = await (await page.request.get(`/sessions/${encodeURIComponent(sessionId!)}`)).json();
  const turn = snapshot.turns[0];
  await page.route((url) => decodeURIComponent(url.pathname) === `/sessions/${sessionId}`, (route) => route.fulfill({ json: {
    ...snapshot, children: [], turns: [{ ...turn, prompt: "Unique turn purpose", tools: [],
      startedAt: "2026-10-21T00:00:00.000Z", endedAt: "2026-10-21T00:00:02.000Z", cost: cost(200),
      requestPerformance: { ttftMs: 1250, durationMs: 2000, outputTokensPerSecond: 42, speedSource: "recorded" },
    }],
  } }));
  await page.reload();
  await page.getByRole("group", { name: "显示单位" }).getByRole("button", { name: "USD", exact: true }).click();
  const table = page.locator(".turn-table");
  await expect(table.locator(".prompt-col")).toHaveText("Unique turn purpose");
  const headers = await table.locator("thead th").allTextContents();
  const cells = table.locator("tbody tr").first().locator("td");
  await expect(cells.nth(headers.findIndex((h) => h.trim() === "本轮目的"))).toHaveText("Unique turn purpose");
  await expect(cells.nth(headers.findIndex((h) => h.trim() === "USD"))).toHaveText("$0.20");
  await expect(cells.nth(headers.findIndex((h) => h.trim() === "TTFT (s)"))).toHaveText("1.25");
  await expect(cells.nth(headers.findIndex((h) => h.trim() === "tok/s"))).toHaveText("42.00");
  expect(headers.findIndex((h) => h.trim() === "分类")).toBe(await table.locator("tbody tr").first().locator(".bucket-col").evaluate((el) => (el as HTMLTableCellElement).cellIndex));
  expect(headers.findIndex((h) => h.trim() === "工具")).toBe(await table.locator("tbody tr").first().locator(".tools-col").evaluate((el) => (el as HTMLTableCellElement).cellIndex));
});

test("trend dates align below bars and anomaly segments retain their proportion", async ({ page }, testInfo) => {
  await mockOverview(page, overview());
  const bars = page.locator(".trend-col");
  await expect(page.locator(".chart-legend")).toContainText("账本 / 解析异常");
  await expect(page.locator(".chart-legend")).not.toContainText("规则命中");
  for (let index = 0; index < 2; index++) {
    const bar = await bars.nth(index).boundingBox();
    const date = await page.locator(".tick").nth(index).boundingBox();
    expect(date!.y).toBeGreaterThanOrEqual(bar!.y + bar!.height);
    expect(Math.abs(date!.x - bar!.x)).toBeLessThan(1);
    await expect(bars.nth(index).locator(".flag")).toHaveAttribute("style", /height: 50%/);
  }
  await bars.first().focus();
  const tooltip = bars.first().locator(".chart-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("账本 / 解析异常");
  const box = await tooltip.boundingBox();
  expect(box!.height).toBeGreaterThan(70);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath("overview-desktop.png"), fullPage: true });
  await bars.first().press("Escape");
  await expect(tooltip).toHaveCount(0);
});

test("the first touch opens the trend tooltip", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await page.route((url) => url.pathname === "/overview", (route) => route.fulfill({ json: overview() }));
    await page.goto(`${baseURL}/#overview`);
    await page.locator(".trend-col").first().tap();
    await expect(page.locator(".chart-tooltip")).toBeVisible();
  } finally { await context.close(); }
});

test("models retain missing usage and scroll inside the disclosure at 320px", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const data = overview();
  data.models = [
    { model: "cursor-unmeasured-model", turnCount: 3, cost: { ...cost(0), unmeasured: 3, credits: null, usd: null }, unpricedRaw: 0 },
    { model: "partially-measured-model", turnCount: 3, cost: { ...cost(100), unmeasured: 2 }, unpricedRaw: 0 },
  ];
  await mockOverview(page, data);
  await page.locator("summary").filter({ hasText: "模型用量" }).click();
  const missing = page.locator(".mt tbody tr").filter({ hasText: "cursor-unmeasured-model" });
  await expect(missing.locator("td").nth(1)).toHaveText("—");
  await expect(missing).toContainText("3 次调用用量未记录");
  await expect(page.locator(".mt tbody tr").filter({ hasText: "partially-measured-model" }).locator("td").nth(1)).toHaveText("≥ 100");
  const scroller = page.getByRole("region", { name: "模型用量表，可横向滚动" });
  await expect(scroller).toBeVisible();
  const dimensions = await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
    return { width: el.clientWidth, scrollWidth: el.scrollWidth, scrollLeft: el.scrollLeft, right: el.getBoundingClientRect().right, viewport: innerWidth };
  });
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.width);
  expect(dimensions.scrollLeft).toBeGreaterThan(0);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
  await page.screenshot({ path: testInfo.outputPath("models-320px.png"), fullPage: true });
});
