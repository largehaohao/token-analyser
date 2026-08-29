import { test, expect, type Page } from "@playwright/test";

async function openSessionDetail(page: Page) {
  await page.getByRole("button", { name: "会话明细" }).click();
}

test("overview shows KPIs and charts", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("group", { name: "时间范围" })).toBeVisible();
  await expect(page.getByRole("button", { name: "全部" })).toBeVisible();
  await expect(page.getByText("预估总费用")).toBeVisible();
  await expect(page.getByText("总 Token 用量")).toBeVisible();
  await expect(page.getByTestId("trend-chart")).toBeVisible();
  await expect(page.getByTestId("donut-chart")).toBeVisible();
});

test("tree percents sum to ~100 and waste moves when poll is unchecked", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({ timeout: 10_000 });
  await openSessionDetail(page);
  await expect(
    page.getByText("wait-poll").or(page.getByText("/repo")).first(),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /s-poll/ }).click();
  await expect(page.getByText(/Not OpenAI's bill/)).toBeVisible();
  const percents = page.locator("[data-percent]");
  await expect(percents.first()).toBeVisible();
  const values = await percents.allTextContents();
  const sum = values.map((v) => parseFloat(v)).reduce((a, b) => a + b, 0);
  expect(sum).toBeGreaterThan(99);
  expect(sum).toBeLessThan(101);
  const waste = page.getByTestId("waste-headline");
  const before = await waste.textContent();
  await page.getByLabel("Waiting poll").uncheck();
  await expect(waste).not.toHaveText(before ?? "");
});

test("shows mix bars for headline, tree, sessions, and turns", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({ timeout: 10_000 });
  await openSessionDetail(page);
  await expect(page.getByRole("group", { name: "时间范围" })).toBeVisible();
  await expect(page.getByRole("button", { name: "7天" })).toBeVisible();
  await expect(page.locator(".session-list li button").first()).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText(/Not OpenAI's bill/)).toBeVisible();
  await expect(page.getByTestId("headline-mix")).toBeVisible();
  await expect(page.getByTestId("context-card")).toBeVisible();
  await expect(page.locator(".session-list .waste-bar").first()).toBeVisible();
  await expect(page.locator(".tree-row .tree-bar").first()).toBeVisible();
  await page.locator(".tree-row").first().click();
  await expect(page.locator(".turn-mix").first()).toBeVisible();
});

test("clicking skills lists the injected catalog", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({ timeout: 10_000 });
  await openSessionDetail(page);
  const skillBtn = page
    .locator(".session-context-meta button")
    .filter({ hasText: "技能" })
    .first();
  await expect(skillBtn).toBeVisible({ timeout: 10_000 });
  await skillBtn.click();
  await expect(page.getByTestId("context-card")).toBeVisible();
  await expect(
    page.locator(".context-items li, .context-empty").first(),
  ).toBeVisible();
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
  await expect(page.getByText(/Not OpenAI's bill/)).toBeVisible();
  await expect(page.locator("[data-testid^='rate-gauge-']").first()).toBeVisible();
  await expect(page.locator(".rate-limits pre")).toHaveCount(0);
});

test("ignores a stale session response after selection changes", async ({ page }) => {
  const sessionsResponse = await page.request.get("/sessions");
  const { sessions } = (await sessionsResponse.json()) as {
    sessions: { id: string; cost: { raw: number } }[];
  };
  const first = sessions.find((session) => session.id === "s-poll");
  const second = sessions.find((session) => session.id === "s-reread-same");
  test.skip(!first || !second || first.cost.raw === second.cost.raw, "fixture sessions unavailable");
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
  const total = page.locator(".headline-row").first().locator(".headline-value");
  await expect(total).toHaveText(second!.cost.raw.toLocaleString("en-US"));
  releaseFirst();
  await expect(total).toHaveText(second!.cost.raw.toLocaleString("en-US"));
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
    cost: emptyCost,
    waste: { ...emptyCost, raw: 0 },
    unpricedRaw: 0,
    days: [],
    slices: [
      "planning",
      "code",
      "reread",
      "subagents",
      "waiting",
      "other",
    ].map((key) => ({ key, raw: 0, credits: 0, usd: 0 })),
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

test("clears session detail when the visible range is empty", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({ timeout: 10_000 });
  await openSessionDetail(page);
  await expect(page.getByText(/Not OpenAI's bill/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "5小时" }).click();
  await expect(page.getByText("该时间范围内没有会话")).toBeVisible();
  await expect(page.getByText("选择一个会话查看费用。")).toBeVisible();
  await expect(page.getByText(/Not OpenAI's bill/)).toHaveCount(0);
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
  await page.getByRole("button", { name: /^bulk-150$/ }).click();
  await expect(page.locator(".session-list li.selected")).toContainText("bulk-150");
  await page.getByLabel("筛选会话").fill("no-such-session");
  await expect(page.getByText("没有匹配的会话")).toBeVisible();
  await page.getByLabel("筛选会话").fill("");
  await expect(page.locator(".session-list li.selected")).toContainText("bulk-150");
  await expect(page.locator(".session-list li")).toHaveCount(200);
});

test("suggestion copy is Chinese and clicking it selects a tree node", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({ timeout: 10_000 });
  await openSessionDetail(page);
  await page.getByRole("button", { name: /s-reread-same/ }).click();
  await expect(page.getByText(/Not OpenAI's bill/)).toBeVisible();
  const suggestion = page.getByRole("button", { name: /相同文件被重复读取/ });
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await expect(page.locator(".tree-row.selected")).toContainText("重复读取");
  await expect(page.locator(".turn-table tr.highlighted")).toBeVisible();
});

test("trend columns expose a keyboard tooltip", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("trend-chart")).toBeVisible({ timeout: 10_000 });
  const col = page.locator(".trend-col").first();
  await expect(col).toHaveAttribute("aria-label", /./);
  await col.focus();
  await expect(col.locator(".chart-tooltip")).toBeVisible();
});
