import { test, expect, type Page } from "@playwright/test";
import type { Cost, Overview, SessionSnapshot } from "../src/api";

function cost(raw: number): Cost {
  return { raw, uncached_input: raw / 4, cached_input: raw / 4, output: raw / 2, credits: raw / 100, usd: raw / 1000 };
}

/** 输出速度固定 28 个桶：≤40、每 10 tok/s 到 300、>300。 */
function tpsBuckets(...counts: [index: number, count: number][]): number[] {
  const buckets = Array<number>(28).fill(0);
  for (const [index, count] of counts) buckets[index] = count;
  return buckets;
}

function overview(raw = 200): Overview {
  return {
    sessionCount: 1, turnCount: 5, live: false, collecting: false, watchPath: "/tmp/review",
    rateCardAsOf: "2026-08-27", cost: cost(raw), waste: cost(0), unpricedRaw: 0,
    days: [
      { date: "2026-10-20", cost: cost(200), flaggedCost: cost(100), unpricedRaw: 0 },
      { date: "2026-10-21", cost: cost(100), flaggedCost: cost(50), unpricedRaw: 0 },
    ], slices: [], models: [],
    performance: {
      taskCount: 5, ttftSampleCount: 2, speedSampleCount: 1, avgTtftMs: 500, outputTokensPerSecond: 5,
      totalDurationMs: 2000, requestDurationMs: 3500, requestDurationCount: 5,
      taskDurationMs: 8000, taskDurationCount: 1, basis: "request",
    },
    performanceDistribution: { ttft: [2, 0, 0, 0, 0], tps: tpsBuckets([0, 1]), sampleCount: 5 },
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
    await expect(comparison).toContainText(/持平|0\.0%/);
    try {
      if (scope === "source") {
        await page.getByRole("combobox", { name: "会话来源", exact: true }).selectOption("pi");
      } else {
        await page.getByRole("button", { name: "5小时", exact: true }).click();
      }
      await expect(page.getByTestId("ledger-hero").locator(".ledger-hero-value")).toContainText("200");
      await expect(comparison).toContainText("—");
    } finally { release(); }
    await expect(comparison).toContainText(/▼ 200（50\.0%）/);
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
  await expect(cells.nth(headers.findIndex((h) => h.trim() === "Token 输入"))).toHaveText("100");
  await expect(cells.nth(headers.findIndex((h) => h.trim() === "Token 输出"))).toHaveText("100");
  await expect(page.getByRole("columnheader", { name: "USD", exact: true })).toHaveCount(0);
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

test("output-speed histogram buckets: ≤40, 10-wide steps to 300, then >300", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const data: Overview = {
    ...overview(),
    performanceDistribution: {
      ttft: [2, 0, 0, 0, 0],
      tps: tpsBuckets([0, 3], [21, 1], [27, 1]),
      sampleCount: 5,
    },
  };
  await mockOverview(page, data);
  const speed = page.locator(".hist-card").nth(1).locator(".hist");
  await expect(speed.locator(".hb")).toHaveCount(28);
  expect(await speed.locator(".hist-tick").allInnerTexts()).toEqual([
    "≤40", "50", "60", "70", "80", "90", "100", "110", "120", "130", "140",
    "150", "160", "170", "180", "190", "200", "210", "220", "230", "240",
    "250", "260", "270", "280", "290", "300", ">300",
  ]);
  // 轴只标边界，占比与完整区间名只在悬停/点按柱体时出现。
  await expect(speed.locator(".hb").nth(1)).toHaveAttribute("title", /^40–50 tok\/s · 0 轮/);
  await expect(speed.locator(".hb").nth(21)).toHaveAttribute("title", /^240–250 tok\/s · 1 轮/);
  await expect(speed.locator(".hb").nth(22)).toHaveAttribute("title", /^250–260 tok\/s · 0 轮/);
  await expect(speed.locator(".hb").nth(26)).toHaveAttribute("title", /^290–300 tok\/s · 0 轮/);
  await expect(speed.locator(".hb").nth(27)).toHaveAttribute("title", /^> 300 tok\/s · 1 轮/);
  await expect(speed.locator(".hb").nth(0)).toHaveAttribute("data-tip", /60\.0%/);
  // 直接派发 click（不移动指针，避免 hover 先置位后被 click 切换掉），验证点按也能出提示。
  await speed.locator(".hb").nth(0).dispatchEvent("click", { bubbles: true });
  await expect(speed.locator(".hb.tip-on")).toHaveCount(1);
  await expect(speed.locator(".hb > b")).toHaveCount(0);
  await expect(page.locator(".hist-card").nth(1).locator(".hist-head .c")).toContainText(
    "5/5 轮有记录 · 多数落在 ≤ 40 tok/s",
  );
  // 窄屏隔一个标，但首桶与末桶必须留着。
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(speed.locator(".hist-tick").first()).toBeVisible();
  await expect(speed.locator(".hist-tick").last()).toBeVisible();
  await expect(speed.locator(".hist-tick").nth(1)).toBeHidden();
});

test("session detail keeps total, input and output inside one card", async ({ page }) => {
  await page.goto("/#overview");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  const rank = page.locator(".rail-rank").first();
  await expect(rank).toBeVisible();
  await rank.click();
  await expect(page.locator(".session-view")).toBeVisible();
  const sessionId = await page.locator(".session-reference").getAttribute("title");
  const snapshot: SessionSnapshot = await (
    await page.request.get(`/sessions/${encodeURIComponent(sessionId!)}`)
  ).json();
  await page.route(
    (url) => decodeURIComponent(url.pathname) === `/sessions/${sessionId}`,
    (route) => route.fulfill({ json: {
      ...snapshot,
      cost: {
        ...snapshot.cost,
        raw: 1_000_000,
        uncached_input: 600_000,
        cached_input: 150_000,
        output: 250_000,
        unmeasured: 0,
      },
    } }),
  );
  await page.reload();
  // 总用量、输入、输出同卡；输入含已缓存部分：600K + 150K，输出 250K，合计 1M raw。
  await expect(page.locator(".headline-row")).toHaveCount(5);
  const totalCard = page.locator(".headline-row").first();
  await expect(totalCard).toContainText("总用量");
  await expect(totalCard.getByTestId("usage-breakdown")).toBeVisible();
  await expect(page.getByTestId("input-headline")).toContainText("750.0K");
  await expect(page.getByTestId("output-headline")).toContainText("250.0K");
  await expect(page.getByTestId("input-headline")).toHaveAttribute(
    "title",
    /^输入 750,000 tokens · 未缓存 600,000 \+ 已缓存 150,000/,
  );
  await expect(page.getByTestId("output-headline")).toHaveAttribute(
    "title",
    /^输出 250,000 tokens/,
  );
  await expect(page.getByTestId("usage-breakdown")).toContainText(
    "占总量 75.0% / 25.0%",
  );
});

test("rolling totals advance while the local dataset is quiet", async ({ page }) => {
  const start = new Date("2026-11-20T09:00:00Z");
  await page.clock.install({ time: start });
  await page.route((url) => url.pathname === "/overview", (route) => {
    const url = new URL(route.request().url());
    const asOf = Date.parse(url.searchParams.get("as_of") ?? "");
    const raw = asOf - start.getTime() < 3_600_000 ? 1_100 : 0;
    return route.fulfill({ json: overview(raw) });
  });
  await page.goto("/#overview");
  await page.getByRole("button", { name: "5小时", exact: true }).click();
  const total = page.getByTestId("ledger-hero").locator(".ledger-hero-value");
  await expect(total).toContainText("1,100");
  await page.clock.fastForward("06:00:00");
  await expect(total).toHaveText("0 tokens");
});

test("a pending local list cannot block environment switching or Back", async ({ page }) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const remoteRow = {
    id: "remote-only", nickname: "远端样例", cost: cost(10), waste: cost(0), source: "pi",
  };
  let delayed = false;
  await page.route((url) => url.pathname === "/sessions", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("env")) {
      await route.fulfill({ json: { sessions: [remoteRow] } });
    } else if (!delayed) {
      delayed = true;
      await wait;
      await route.fulfill({ json: { sessions: [] } }).catch(() => undefined);
    } else {
      await route.fulfill({ json: { sessions: [] } });
    }
  });
  const localList = page.waitForRequest((request) => new URL(request.url()).pathname === "/sessions");
  try {
    await page.goto("/#sessions");
    await localList;
    const env = page.getByRole("combobox", { name: "分析环境", exact: true });
    await page.getByRole("button", { name: "全部", exact: true }).click();
    await env.selectOption("192.168.1.102");
    await expect(page.locator(".session-main")).toContainText("远端样例");
    release();
    await expect(page.locator(".session-main")).toContainText("远端样例");
    await page.goBack();
    await expect(env).toHaveValue("local");
    await expect(page.locator(".session-main")).toHaveCount(0);
  } finally {
    release();
  }
});

test("behavior ranking opens matching sessions and can be cleared", async ({ page }) => {
  await page.goto("/#overview");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  const waiting = page.getByTestId("behavior-rank").locator(".rank-row").filter({ hasText: "等待 / 轮询" });
  const matching = page.waitForResponse((response) => new URL(response.url()).searchParams.get("behavior") === "waiting");
  await waiting.getByRole("button", { name: "查看会话" }).click();
  const { sessionIds } = await (await matching).json() as { sessionIds: string[] };
  expect(sessionIds.length).toBeGreaterThan(0);
  await expect(page.getByText("行为 · 等待 / 轮询")).toBeVisible();
  await expect(page.locator(".session-main")).toHaveCount(sessionIds.length);
  await page.getByRole("button", { name: "清除行为筛选" }).click();
  await expect(page.locator(".session-main").nth(sessionIds.length)).toBeVisible();
});

test("any missing usage keeps the comparison uncertain and the mobile sparkline compact", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const data = overview(1_100);
  const sample = data.days[0]!;
  data.days = Array.from({ length: 8 }, (_, index) => ({ ...sample, date: `2026-10-${20 + index}` }));
  const incomplete = { ...data, cost: { ...data.cost, unmeasured: 1 } };
  await page.route((url) => url.pathname === "/overview", (route) =>
    route.fulfill({ json: new URL(route.request().url()).searchParams.has("until") ? data : incomplete }));
  await page.goto("/#overview");
  const hero = page.getByTestId("ledger-hero");
  await expect(hero).toContainText("部分用量缺失，无法比较");
  const spark = hero.getByRole("group", { name: /统计窗口内每日用量趋势/ });
  expect((await spark.boundingBox())!.height).toBeLessThan(120);
  await page.setViewportSize({ width: 1440, height: 900 });
  const firstPoint = await spark.locator("svg").evaluate((node) => {
    const screen = new DOMPoint(3, 44).matrixTransform((node as SVGSVGElement).getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.move(firstPoint.x, firstPoint.y);
  await expect(spark.locator(".chart-tooltip b")).toHaveText("2026-10-20");
  await page.setViewportSize({ width: 390, height: 844 });
  await spark.focus();
  await page.keyboard.press("Tab");
  const drill = hero.getByRole("button", { name: "查看当日会话" });
  await expect(drill).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(spark).toBeFocused();
  await expect(drill).toHaveCount(0);
  await spark.press("End");
  await spark.press("Enter");
  await expect(page.getByRole("complementary", { name: "会话列表", exact: true }).getByLabel("清除日期筛选")).toBeVisible();
});

test("an unfinished startup scan replaces a provisional empty total with progress", async ({ page }) => {
  let scanning = true;
  await page.route((url) => url.pathname === "/overview", (route) => route.fulfill({
    json: scanning
      ? { ...overview(0), sessionCount: 0, indexing: { completed: 0, total: 2 } }
      : overview(200),
  }));
  await page.goto("/#overview");
  await expect(page.getByText(/已处理 0 \/ 2 个变更文件/)).toBeVisible();
  await expect(page.getByTestId("ledger-hero")).toHaveCount(0);
  await expect(page.getByText("该时间范围内没有会话", { exact: true })).toHaveCount(0);
  scanning = false;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByTestId("ledger-hero").locator(".ledger-hero-value")).toContainText("200");
  await expect(page.getByText(/个变更文件/)).toHaveCount(0);
});
