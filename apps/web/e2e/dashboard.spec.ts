import { test, expect, type Page } from "@playwright/test";

async function openSessionDetail(page: Page) {
  await page.getByRole("link", { name: "会话明细" }).click();
}

test("overview keeps secondary analysis collapsed and accessible by keyboard", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({
    timeout: 10_000,
  });
  const viewNavigation = page.getByRole("navigation", { name: "视图" });
  await expect(viewNavigation).toHaveClass(/primary-nav/);
  await expect(viewNavigation).toBeVisible();
  await expect(viewNavigation.getByRole("link")).toHaveCount(2);
  await expect(page.getByRole("group", { name: "时间范围" })).toBeVisible();
  await expect(page.getByRole("button", { name: "全部" })).toBeVisible();
  await expect(page.locator(".kpi-label", { hasText: "总用量" })).toBeVisible();
  await expect(
    page.locator(".kpi-label", { hasText: "预估总费用" }),
  ).toBeVisible();
  await expect(page.locator(".disclaimer")).toContainText(/不代表 OpenAI 账单/);
  await expect(page.locator(".disclaimer")).toContainText("2026-08-29");
  await expect(page.getByTestId("trend-chart")).toBeVisible();
  await expect(page.getByTestId("donut-chart")).toBeHidden();
  await expect(page.getByTestId("model-mix")).toBeHidden();
  await expect(page.getByLabel("数据质量", { exact: true })).toBeHidden();
  const composition = page
    .locator("summary")
    .filter({ hasText: "Token 构成与行为分类" });
  await composition.press("Enter");
  await expect(page.getByTestId("donut-chart")).toBeVisible();
  await page.getByRole("button", { name: "Credits", exact: true }).click();
  await expect(page.getByTestId("donut-chart")).toBeVisible();
  await composition.press("Enter");
  await expect(page.getByTestId("donut-chart")).toBeHidden();
  await page.locator("summary").filter({ hasText: "模型用量" }).click();
  await expect(page.getByTestId("model-mix")).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "数据质量与统计口径" })
    .click();
  await expect(page.getByLabel("数据质量", { exact: true })).toBeVisible();
});

test("unit switcher keeps tokens paired with credits instead of duplicating tokens", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("button", { name: "Tokens" })).toHaveClass(
    /active/,
  );
  const tokenKpi = page.locator(".kpi-card").filter({
    has: page.locator(".kpi-label", { hasText: "总用量" }),
  });
  const moneyKpi = page.locator(".kpi-card").filter({
    has: page.locator(".kpi-label", { hasText: "预估总费用" }),
  });
  await expect(tokenKpi.locator(".kpi-value")).toContainText("tokens");
  await expect(moneyKpi.locator(".kpi-value")).toContainText("credits");
  const tokenText = await tokenKpi.locator(".kpi-value").innerText();
  const moneyText = await moneyKpi.locator(".kpi-value").innerText();
  expect(tokenText).not.toEqual(moneyText);

  await page.getByRole("button", { name: "Credits" }).click();
  await expect(
    page.locator(".kpi-label", { hasText: "总 Token 用量" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".kpi-card")
      .filter({
        has: page.locator(".kpi-label", { hasText: "预估总费用" }),
      })
      .locator(".kpi-value"),
  ).toContainText("credits");

  await page.getByRole("button", { name: "USD" }).click();
  await expect(
    page
      .locator(".kpi-card")
      .filter({
        has: page.locator(".kpi-label", { hasText: "预估总费用" }),
      })
      .locator(".kpi-value"),
  ).toContainText("USD");
  await page.getByRole("button", { name: "Tokens" }).click();
});

test("tree percents sum to ~100 and waste moves when poll is unchecked", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({
    timeout: 10_000,
  });
  await openSessionDetail(page);
  await expect(
    page.getByText("wait-poll").or(page.getByText("/repo")).first(),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /s-poll/ }).click();
  await expect(page.getByText(/不代表 OpenAI 账单/)).toBeVisible();
  const percents = page.locator("[data-percent]");
  await expect(percents.first()).toBeVisible();
  const values = await percents.allTextContents();
  const sum = values.map((v) => parseFloat(v)).reduce((a, b) => a + b, 0);
  expect(sum).toBeGreaterThan(99);
  expect(sum).toBeLessThan(101);
  const total = page.locator(".tree-row").first().locator(".tree-cost");
  const originalTotal = await total.getAttribute("title");
  await expect(page.locator(".tree-row.muted")).toHaveCount(0);
  await page.getByRole("button", { name: "显示零用量分类" }).click();
  await expect(page.locator(".tree-row.muted").first()).toBeVisible();
  await page.getByRole("button", { name: "隐藏零用量分类" }).click();
  await expect(page.locator(".tree-row.muted")).toHaveCount(0);
  await expect(total).toHaveAttribute("title", originalTotal!);
  await page
    .locator("summary")
    .filter({ hasText: "优化建议与浪费规则" })
    .click();
  const waste = page.getByTestId("waste-headline");
  const poll = page.getByLabel("轮询等待");
  if (!(await poll.isChecked())) {
    await poll.check();
  }
  await expect(waste).not.toHaveText("0");
  const before = await waste.textContent();
  await poll.uncheck();
  await expect(waste).not.toHaveText(before ?? "");
});

test("shows mix bars for headline, tree, sessions, and turns", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({
    timeout: 10_000,
  });
  await openSessionDetail(page);
  await expect(page.getByRole("group", { name: "时间范围" })).toBeVisible();
  await expect(page.getByRole("button", { name: "7天" })).toBeVisible();
  await expect(page.locator(".session-list li button").first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/不代表 OpenAI 账单/)).toBeVisible();
  await expect(page.getByTestId("headline-mix")).toBeVisible();
  await expect(page.getByTestId("context-card")).toBeHidden();
  await expect(page.locator(".session-list .waste-bar").first()).toBeVisible();
  await expect(page.locator(".tree-row .tree-bar").first()).toBeVisible();
  await page.locator(".tree-row").first().click();
  await expect(page.locator(".turn-mix").first()).toBeVisible();
  await expect(page.locator(".turn-table th")).toHaveCount(6);
  const turnRow = page.locator(".turn-table tbody tr").first();
  const exactRaw = await turnRow.locator(".turn-total").getAttribute("title");
  await turnRow.getByRole("button").press("Enter");
  const breakdown = page.getByLabel("Token 与费用明细");
  await expect(breakdown).toBeVisible();
  await expect(
    breakdown
      .locator("div")
      .filter({ has: page.getByText("总 Token", { exact: true }) })
      .locator("dd"),
  ).toHaveText(exactRaw!.replace(/ tokens$/, ""));
  await expect(page.getByRole("heading", { name: "提示" })).toBeVisible();
  await page.getByRole("button", { name: "Credits", exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: "credits", exact: true }),
  ).toBeVisible();
  await expect(breakdown).toBeVisible();
  await expect(turnRow.locator(".turn-total")).toHaveAttribute(
    "title",
    /credits|未定价/,
  );
});

test("clicking skills lists the injected catalog", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({
    timeout: 10_000,
  });
  await openSessionDetail(page);
  const skillBtn = page
    .locator(".session-context-meta button")
    .filter({ hasText: "技能" })
    .first();
  await expect(skillBtn).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("context-card")).toBeHidden();
  await skillBtn.click();
  await expect(page.getByTestId("context-card")).toBeVisible();
  await expect(
    page.locator(".context-items li, .context-empty").first(),
  ).toBeVisible();
  await page.locator("summary").filter({ hasText: "上下文与会话信息" }).click();
  await expect(page.getByTestId("context-card")).toBeHidden();
  await skillBtn.click();
  await expect(
    page.locator(".context-items li, .context-empty").first(),
  ).toBeVisible();
  await page.getByRole("link", { name: "成本总览", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "成本总览", exact: true }),
  ).toBeInViewport();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("renders rate limit gauges instead of raw JSON", async ({ page }) => {
  const listResponse = await page.request.get("/sessions");
  const { sessions } = (await listResponse.json()) as {
    sessions: { id: string }[];
  };
  let targetId: string | null = null;
  for (const session of sessions.slice(0, 8)) {
    const snapResponse = await page.request.get(`/sessions/${session.id}`);
    if (!snapResponse.ok()) continue;
    const snap = (await snapResponse.json()) as { rate_limits: unknown };
    if (snap.rate_limits != null) {
      targetId = session.id;
      break;
    }
  }
  test.skip(!targetId, "no session with rate limits");
  await page.goto("/");
  await openSessionDetail(page);
  await page.getByRole("button", { name: new RegExp(targetId!) }).click();
  await expect(page.getByText(/不代表 OpenAI 账单/)).toBeVisible();
  await page.locator("summary").filter({ hasText: "上下文与会话信息" }).click();
  await expect(
    page.locator("[data-testid^='rate-gauge-']").first(),
  ).toBeVisible();
  await expect(page.locator(".rate-limits pre")).toHaveCount(0);
});

test("ignores a stale session response after selection changes", async ({
  page,
}) => {
  const sessionsResponse = await page.request.get("/sessions");
  const { sessions } = (await sessionsResponse.json()) as {
    sessions: { id: string; cost: { raw: number } }[];
  };
  const first = sessions.find((session) => session.id === "s-poll");
  const second = sessions.find((session) => session.id === "s-reread-same");
  test.skip(
    !first || !second || first.cost.raw === second.cost.raw,
    "fixture sessions unavailable",
  );
  const [firstSnapshotResponse, secondSnapshotResponse] = await Promise.all([
    page.request.get(`/sessions/${first!.id}`),
    page.request.get(`/sessions/${second!.id}`),
  ]);
  const firstSnapshot = await firstSnapshotResponse.json();
  const secondSnapshot = await secondSnapshotResponse.json();

  let releaseFirst!: () => void;
  let firstRequested!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstRequest = new Promise<void>((resolve) => {
    firstRequested = resolve;
  });

  await page.route("**/sessions", (route) =>
    route.fulfill({ json: { sessions: [first, second] } }),
  );
  await page.route("**/sessions/s-poll", async (route) => {
    firstRequested();
    await firstGate;
    await route.fulfill({ json: firstSnapshot });
  });
  await page.route("**/sessions/s-reread-same", (route) =>
    route.fulfill({ json: secondSnapshot }),
  );

  await page.goto("/");
  await openSessionDetail(page);
  await firstRequest;
  await page.getByRole("button", { name: /s-reread-same/ }).click();
  const total = page
    .locator(".headline-row")
    .first()
    .locator(".headline-value");
  await expect(total).toHaveAttribute(
    "title",
    `${second!.cost.raw.toLocaleString("en-US")} tokens`,
  );
  releaseFirst();
  await expect(total).toHaveAttribute(
    "title",
    `${second!.cost.raw.toLocaleString("en-US")} tokens`,
  );
});

test("starts a fresh session request after leaving and re-entering details", async ({
  page,
}) => {
  const response = await page.request.get("/sessions/s-poll");
  test.skip(!response.ok(), "fixture session unavailable");
  const snapshot = await response.json();
  let calls = 0;
  let releaseFirst!: () => void;
  let firstRequested!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstRequest = new Promise<void>((resolve) => {
    firstRequested = resolve;
  });

  await page.route("**/sessions/s-poll", async (route) => {
    calls += 1;
    if (calls === 1) {
      firstRequested();
      await firstGate;
    }
    await route.fulfill({ json: snapshot });
  });

  await page.goto("/");
  await openSessionDetail(page);
  await page.getByRole("button", { name: /s-poll/ }).click();
  await firstRequest;

  await page.getByRole("link", { name: "成本总览" }).click();
  await expect(page.getByTestId("overview-page")).toBeVisible({
    timeout: 10_000,
  });
  await openSessionDetail(page);
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator(".session-view")).toBeVisible();
  releaseFirst();
});

test("keeps the current session detail when a refresh fails temporarily", async ({
  page,
}) => {
  let failedRefresh = false;
  await page.goto("/");
  await openSessionDetail(page);
  await page.getByRole("button", { name: /s-poll/ }).click();
  await expect(page.getByText(/不代表 OpenAI 账单/)).toBeVisible({
    timeout: 10_000,
  });

  await page.route("**/sessions/s-poll", async (route) => {
    if (!failedRefresh) {
      failedRefresh = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary backend failure" }),
      });
      return;
    }
    await route.continue();
  });

  // Re-entering the detail view triggers the same refresh path as a live
  // update or the periodic refresh, while keeping the selected session.
  await page.getByRole("link", { name: "成本总览" }).click();
  await expect(page.getByTestId("overview-page")).toBeVisible({
    timeout: 10_000,
  });
  await openSessionDetail(page);
  await expect.poll(() => failedRefresh).toBe(true);
  await expect(page.getByText(/不代表 OpenAI 账单/)).toBeVisible();
  await expect(page.getByText("选择一个会话查看费用。")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("会话更新失败");

  await page.getByRole("link", { name: "成本总览" }).click();
  await expect(page.getByTestId("overview-page")).toBeVisible({
    timeout: 10_000,
  });
  await openSessionDetail(page);
  await expect(page.locator(".session-view")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("restores the session detail after a document reload", async ({
  page,
}) => {
  await page.goto("/");
  await openSessionDetail(page);
  await page.getByRole("button", { name: /s-poll/ }).click();
  await expect(page.getByText(/不代表 OpenAI 账单/)).toBeVisible({
    timeout: 10_000,
  });

  await page.reload();

  await expect(page.getByTestId("overview-page")).toHaveCount(0);
  await expect(page.locator(".session-view")).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.locator(".session-list li.selected .session-id"),
  ).toHaveText("s-poll");
});

function overviewPayload(sessionCount: number) {
  const emptyCost = {
    raw: sessionCount > 0 ? 100 : 0,
    uncached_input: 0,
    cached_input: 0,
    output: 0,
    credits: 0,
    usd: 0,
  };
  return {
    sessionCount,
    turnCount: sessionCount > 0 ? 4 : 0,
    live: false,
    collecting: true,
    watchPath: "/tmp",
    rateCardAsOf: "2026-08-27",
    cost: emptyCost,
    waste: { ...emptyCost, raw: 0 },
    unpricedRaw: 0,
    days: [],
    slices: [
      "planning",
      "reading",
      "verification",
      "code",
      "reread",
      "tooling",
      "communication",
      "subagents",
      "waiting",
      "other",
    ].map((key) => ({ key, raw: 0, credits: 0, usd: 0 })),
    models: [],
  };
}

test("ignores a stale overview after the range changes", async ({ page }) => {
  let release7d!: () => void;
  let sevenRequested!: () => void;
  let sevenFulfilled = false;
  const gate = new Promise<void>((resolve) => {
    release7d = resolve;
  });
  const sevenReq = new Promise<void>((resolve) => {
    sevenRequested = resolve;
  });

  await page.route(
    (url) => url.pathname === "/overview",
    async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("days") === "8") {
        sevenRequested();
        await gate;
        await route.fulfill({ json: overviewPayload(99) });
        sevenFulfilled = true;
        return;
      }
      await route.fulfill({ json: overviewPayload(0) });
    },
  );

  await page.goto("/");
  await sevenReq;
  await page.getByRole("button", { name: "5小时" }).click();
  const sessionKpi = page.getByRole("button", { name: /已分析会话/ });
  await expect(sessionKpi).toContainText("0", { timeout: 10_000 });
  await expect(page.getByText("该时间范围内没有会话")).toBeVisible();
  release7d();
  await expect.poll(() => sevenFulfilled).toBe(true);
  await expect(sessionKpi).toContainText("0");
  await expect(sessionKpi).not.toContainText("99");
  await expect(page.getByTestId("overview-page")).toBeVisible();
});

test("clears session detail when the visible range is empty", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({
    timeout: 10_000,
  });
  await openSessionDetail(page);
  await expect(page.getByText(/不代表 OpenAI 账单/)).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "5小时" }).click();
  await expect(page.getByText("该时间范围内没有会话")).toBeVisible();
  await expect(page.getByText("选择一个会话查看费用。")).toBeVisible();
  await expect(page.locator(".session-view .disclaimer")).toHaveCount(0);
});

test("session list pages instead of rendering thousands of rows", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const emptyCost = {
    raw: 1,
    uncached_input: 0,
    cached_input: 0,
    output: 0,
    credits: 0,
    usd: 0,
  };
  const sessions = Array.from({ length: 3000 }, (_, i) => ({
    id: `bulk-${i}`,
    parentId: null,
    nickname: `bulk-${i}`,
    cwd: "/repo",
    live: false,
    model: "gpt-5.6",
    effort: "medium",
    startedAt: now,
    lastEventAt: now,
    cost: emptyCost,
    waste: { ...emptyCost, raw: 0 },
    parse_error: false,
    ledger_warning: false,
    toolsChars: 0,
    toolsCount: 0,
    skillsChars: 0,
    skillsCount: 0,
  }));

  await page.route("**/sessions", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/sessions") {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { sessions } });
  });

  await page.goto("/");
  await openSessionDetail(page);
  await expect(page.locator(".session-list li")).toHaveCount(100, {
    timeout: 10_000,
  });
  await page.getByTestId("session-load-more").click();
  await expect(page.locator(".session-list li")).toHaveCount(200);
  await page
    .locator(".session-id")
    .filter({ hasText: /^bulk-150$/ })
    .click();
  await expect(
    page.locator(".session-list li.selected .session-id"),
  ).toHaveText("bulk-150");
  await page.getByLabel("筛选会话").fill("no-such-session");
  await expect(page.getByText("没有匹配的会话")).toBeVisible();
  await page.getByLabel("筛选会话").fill("");
  await expect(
    page.locator(".session-list li.selected .session-id"),
  ).toHaveText("bulk-150");
  await expect(page.locator(".session-list li")).toHaveCount(200);
});

test("suggestion copy is Chinese and clicking it selects a tree node", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({
    timeout: 10_000,
  });
  await openSessionDetail(page);
  await page.getByRole("button", { name: /s-reread-same/ }).click();
  await expect(page.getByText(/不代表 OpenAI 账单/)).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "优化建议与浪费规则" })
    .click();
  const suggestion = page.getByRole("button", { name: /相同文件被重复读取/ });
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await expect(page.locator(".tree-row.selected")).toContainText("重复读取");
  await expect(page.locator(".turn-table tr.highlighted")).toBeVisible();
});

test("trend columns expose a keyboard tooltip", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("trend-chart")).toBeVisible({
    timeout: 10_000,
  });
  const col = page.locator(".trend-col").first();
  await expect(col).toHaveAttribute("aria-label", /./);
  await col.focus();
  await expect(col.locator(".chart-tooltip")).toBeVisible();
});

test("overview keeps data warnings visible while quality details are collapsed", async ({
  page,
}) => {
  const payload = overviewPayload(1);
  await page.route("**/overview?**", (route) =>
    route.fulfill({
      json: {
        ...payload,
        cost: { ...payload.cost, uncached_input: 100 },
        quality: {
          pricedRaw: 100,
          unpricedRaw: 0,
          ledgerWarningSessions: 2,
          parseErrors: 0,
        },
      },
    }),
  );
  await page.goto("/");
  await expect(page.locator(".data-notice")).toBeVisible();
  await expect(page.locator(".data-notice")).toContainText(
    "2 项账本或解析异常",
  );
  await expect(page.getByLabel("数据质量", { exact: true })).toBeHidden();
});

for (const width of [1600, 1440, 390]) {
  test(`summary and drilldowns stay within the page at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const expectContained = async () => {
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    };
    await page.goto("/");
    await expect(page.getByTestId("overview-page")).toBeVisible();
    await expectContained();
    await page
      .locator("summary")
      .filter({ hasText: "Token 构成与行为分类" })
      .click();
    await expect(page.getByTestId("donut-chart")).toBeVisible();
    await expectContained();
    await openSessionDetail(page);
    await expect(page.getByTestId("headline-mix")).toBeVisible();
    await expectContained();
    if (width >= 1440) {
      expect(
        await page
          .locator(".turn-table-scroll")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
    }
    await page.locator(".turn-expand").first().press("Enter");
    await expect(page.getByLabel("Token 与费用明细")).toBeVisible();
    await expectContained();
  });
}
