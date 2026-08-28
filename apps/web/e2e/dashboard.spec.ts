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
