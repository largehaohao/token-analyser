import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function openSessions(page: Page) {
  await page.goto("/#sessions");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.locator(".session-main").filter({ hasText: "s-poll" }).click();
  await expect(page.locator(".session-reference")).toHaveText("s-poll");
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("per-request TTFT and tok/s show recorded, calculated, and missing measurements", async ({ page }, testInfo) => {
  const id = "request-performance-e2e";
  const now = Date.now() - 20000;
  const usage = (output: number) => ({ input_tokens: 1000, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: output, reasoning_output_tokens: 0, total_tokens: 1000 + output });
  const rows = [
    { type: "session_meta", payload: { id, cwd: "/request-performance-test" } },
    { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "task" } },
    { type: "event_msg", payload: { type: "token_count", request_performance: { ttft_ms: 250, duration_ms: 1000, tokens_per_second: 75 }, info: { last_token_usage: usage(100), total_token_usage: usage(100) } } },
    { type: "event_msg", payload: { type: "token_count", request_performance: { ttft_ms: 500, duration_ms: 2000 }, info: { last_token_usage: usage(100), total_token_usage: usage(200) } } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(100), total_token_usage: usage(300) } } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "task", duration_ms: 10000, time_to_first_token_ms: 1500 } },
  ].map((row, i) => JSON.stringify({ timestamp: new Date(now + i * 1000).toISOString(), ...row })).join("\n") + "\n";
  const res = await page.request.post("/import", { headers: { "Content-Type": "application/x-ndjson", "X-Filename": "request-performance.jsonl" }, data: rows });
  expect(res.ok()).toBe(true);
  await page.goto("/#sessions");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.getByRole("searchbox", { name: "筛选会话" }).fill(id);
  await page.locator(".session-main").first().click();
  await expect(page.getByRole("columnheader", { name: "TTFT (s)" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "tok/s", exact: true })).toBeVisible();
  const requests = page.locator(".turn-table tbody tr:not(.turn-detail-row)").filter({ has: page.locator(".turn-expand") });
  await expect(requests).toHaveCount(3);
  await expect(requests.nth(0).locator("td.turn-performance")).toHaveText(["—", "—"]);
  await expect(requests.nth(1).locator("td.turn-performance")).toHaveText(["0.50", "50.00"]);
  await expect(requests.nth(2).locator("td.turn-performance")).toHaveText(["0.25", "75.00"]);
  await requests.nth(1).getByRole("button").click();
  await expect(page.getByLabel("本次 LLM 请求性能")).toContainText("50.00 tok/s");
  await expect(page.locator(".turn-detail")).toContainText("含首 token 等待");
  await requests.nth(0).getByRole("button").click();
  await expect(page.getByLabel("本次 LLM 请求性能")).toContainText("— s");
  await expect(page.locator(".turn-detail")).toContainText("日志未记录本次请求的 TTFT");
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator(".turn-detail").screenshot({ path: testInfo.outputPath("request-performance-mobile.png") });
});

test("Fast pricing follows desktop tier changes and shows effective token rates", async ({ page }, testInfo) => {
  const id = "fast-pricing-e2e";
  const now = Date.now() - 10_000;
  const usage = (multiple = 1) => ({
    input_tokens: 1_000_000 * multiple, cached_input_tokens: 500_000 * multiple,
    cache_write_input_tokens: 0, output_tokens: 100_000 * multiple,
    reasoning_output_tokens: 0, total_tokens: 1_100_000 * multiple,
  });
  const rows = [
    { type: "session_meta", payload: { id, cwd: "/fast-pricing-test" } },
    { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(), total_token_usage: usage() } } },
    { type: "event_msg", payload: { type: "thread_settings_applied", thread_id: id, thread_settings: { model: "gpt-6.1-sol", service_tier: "priority" } } },
    { type: "turn_context", payload: { model: "gpt-6.1-sol" } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage(), total_token_usage: usage(2) } } },
  ].map((row, index) => JSON.stringify({ timestamp: new Date(now + index * 1000).toISOString(), ...row })).join("\n") + "\n";
  const imported = await page.request.post("/import", {
    headers: { "Content-Type": "application/x-ndjson", "X-Filename": "fast-pricing.jsonl" },
    data: rows,
  });
  expect(imported.ok()).toBe(true);
  const snapshot = await imported.json();
  expect(snapshot.turns.map((turn: { cost: { credits: number } }) => turn.cost.credits)).toEqual([51.25, 102.5]);
  expect(snapshot.cost.credits).toBe(153.75);
  await page.goto("/");
  await expect(page.locator(".pricing-mode-note")).toContainText("Fast ×2（购入 credits）");
  await page.goto("/#sessions");
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.getByRole("searchbox", { name: "筛选会话" }).fill(id);
  await page.locator(".session-main").first().click();
  await expect(page.locator(".turn-fast")).toHaveText("Fast ×2");
  await page.locator(".turn-expand").first().click();
  await expect(page.getByLabel("Token 与费用明细")).toContainText("Fast ×2");
  await expect(page.getByLabel("Token 单价")).toHaveText("每百万 token（credits）：未缓存输入 100 · 缓存输入 5 · 输出 500");
  await page.locator(".turn-detail").screenshot({ path: testInfo.outputPath("fast-pricing-desktop.png") });
  await page.locator(".turn-expand").nth(1).click();
  await expect(page.getByLabel("Token 与费用明细")).toContainText("Standard ×1");
  await expect(page.getByLabel("Token 单价")).toContainText("未缓存输入 50 · 缓存输入 2.5 · 输出 250");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator(".turn-expand").first().click();
  await expect(page.getByLabel("Token 单价")).toContainText("输出 500");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator(".turn-detail").screenshot({ path: testInfo.outputPath("fast-pricing-mobile.png") });
});

test("TTFT and tok/s render on overview and session details", async ({ page }, testInfo) => {
  const data = await (await page.request.get("/overview?days=8")).json();
  let measured = true;
  await page.route("**/overview?**", async (route) => {
    await route.fulfill({ json: {
      ...data,
      performance: measured ? {
        taskCount: 2, ttftSampleCount: 2, speedSampleCount: 2,
        avgTtftMs: 1250, outputTokensPerSecond: 42.5,
      } : { taskCount: 0, ttftSampleCount: 0, speedSampleCount: 0, avgTtftMs: null, outputTokensPerSecond: null },
    } });
  });
  await page.goto("/");
  await expect(page.getByTestId("ttft-value")).toHaveText("1.25 s");
  await expect(page.getByTestId("token-speed-value")).toHaveText("42.50 tok/s");
  await expect(page.getByLabel("响应性能")).toContainText("包含思考、工具执行与等待");
  await page.getByLabel("响应性能").screenshot({ path: testInfo.outputPath("performance-desktop.png") });
  await page.setViewportSize({ width: 375, height: 812 });
  const panel = await page.getByLabel("响应性能").boundingBox();
  expect(panel?.width).toBeLessThanOrEqual(375);
  await page.getByLabel("响应性能").screenshot({ path: testInfo.outputPath("performance-mobile.png") });
  measured = false;
  await page.reload();
  await expect(page.getByTestId("ttft-value")).toHaveText("— s");
  await expect(page.getByTestId("token-speed-value")).toHaveText("— tok/s");
  await expect(page.getByText("日志未记录首 token 时间")).toBeVisible();

  await page.route("**/sessions/s-poll", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ json: {
      ...await response.json(),
      performance: {
        taskCount: 1, ttftSampleCount: 1, speedSampleCount: 1,
        avgTtftMs: 0, outputTokensPerSecond: 0,
      },
    } });
  });
  await openSessions(page);
  await expect(page.getByTestId("ttft-value")).toHaveText("0.00 s");
  await expect(page.getByTestId("token-speed-value")).toHaveText("0.00 tok/s");
});

test("overview updates model pricing with visible loading and success states", async ({
  page,
}) => {
  const update = gate();
  await page.route("**/pricing/update", async (route) => {
    await update.promise;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ asOf: "2026-09-23", modelCount: 13 }),
    });
  });

  await page.goto("/");
  await expect(page.getByTestId("overview-page")).toBeVisible({
    timeout: 10_000,
  });
  const button = page.getByRole("button", { name: "更新模型价格" });
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toBeDisabled();
  await expect(
    page.getByText("正在从 OpenAI 官网读取模型价格…"),
  ).toBeVisible();

  update.release();
  await expect(
    page.getByText(
      "已同步 13 种模型价格（2026-09-23），并重新计算本地成本。",
    ),
  ).toBeVisible();
  await expect(button).toBeEnabled();
});

test("Back and reload retain private filters, selection, and range", async ({
  page,
}) => {
  await openSessions(page);
  const search = page.getByRole("searchbox", { name: "筛选会话" });
  await search.fill("s-poll");
  await expect(page.locator(".session-main")).toHaveCount(1);
  await page.getByRole("link", { name: "成本总览", exact: true }).click();
  await expect(page).toHaveTitle("成本总览 · Token Analyser");
  await page.goBack();
  await expect(page).toHaveURL(/#sessions$/);
  await expect(search).toHaveValue("s-poll");
  await expect(
    page.getByRole("button", { name: "全部", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(search).toHaveValue("s-poll");
  await expect(page.locator(".session-reference")).toHaveText("s-poll");
  expect(page.url()).not.toContain("s-poll");
  await page.getByRole("button", { name: "清除会话搜索" }).click();
  await expect(search).toHaveValue("");
  await expect(search).toBeFocused();
  await expect(page.locator(".session-main")).not.toHaveCount(1);
});

test("IME composition does not filter early and no-results preserves the open detail", async ({
  page,
}) => {
  await openSessions(page);
  const search = page.getByRole("searchbox", { name: "筛选会话" });
  const count = await page.locator(".session-main").count();
  await search.dispatchEvent("compositionstart");
  await search.fill("s-poll");
  await search.press("Enter");
  await expect(page.locator(".session-main")).toHaveCount(count);
  await search.dispatchEvent("compositionend", { data: "s-poll" });
  await expect(page.locator(".session-main")).toHaveCount(1);
  await search.fill("不存在的会话-unknown-project");
  await expect(
    page.getByRole("heading", { name: "没有匹配的会话" }),
  ).toBeVisible();
  await expect(page.locator(".session-view")).toBeVisible();
  await expect(page.locator(".list-selection-note")).toBeVisible();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await expect(search).toBeFocused();
  await expect(page.locator(".session-main")).toHaveCount(count);
});

test("overview loading reserves the header and reduced motion disables the spinner", async ({
  page,
}) => {
  const data = await (await page.request.get("/overview?days=8")).json();
  const pending = gate();
  await page.route("**/overview?**", async (route) => {
    await pending.promise;
    await route.fulfill({ json: data });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#overview");
  await expect(
    page.getByRole("heading", { name: "正在汇总本地用量" }),
  ).toBeVisible();
  await expect(page.locator(".spinner")).toHaveCSS("animation-name", "none");
  const before = await page.locator(".app-header").boundingBox();
  pending.release();
  await expect(page.getByTestId("overview-page")).toBeVisible();
  expect(await page.locator(".app-header").boundingBox()).toEqual(before);
});

test("overview failure has a retry and retains navigation", async ({
  page,
}) => {
  await page.route("**/overview?**", (route) =>
    route.fulfill({ status: 503, json: { error: "test failure" } }),
  );
  await page.goto("/#overview");
  await expect(
    page.getByRole("heading", { name: "总览加载失败" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "会话明细" })).toBeVisible();
  await page.unroute("**/overview?**");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByTestId("overview-page")).toBeVisible();
});

test("a failed background overview refresh preserves readable data", async ({
  page,
}) => {
  await page.goto("/#overview");
  await expect(page.getByTestId("overview-page")).toBeVisible();
  const total = await page.locator(".kpi-value").first().textContent();
  await page.route("**/overview?**", (route) =>
    route.fulfill({ status: 503, json: { error: "test offline" } }),
  );
  const snapshot = await (await page.request.get("/sessions/s-poll")).json();
  await page.request.patch("/sessions/s-poll/waste-toggles", {
    data: snapshot.toggles,
  });
  await expect(page.getByRole("alert")).toContainText("总览更新失败");
  await expect(page.locator(".kpi-value").first()).toHaveText(total!);
  await page.unroute("**/overview?**");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("failed lists and missing sessions have distinct recovery states", async ({
  page,
}) => {
  await page.route("**/sessions", (route) =>
    route.fulfill({ status: 503, json: { error: "test failure" } }),
  );
  await page.goto("/#sessions");
  await expect(
    page.getByRole("heading", { name: "会话列表加载失败" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "暂时无法读取会话" }),
  ).toBeVisible();
  await page.unroute("**/sessions");
  await page.getByRole("button", { name: "刷新列表", exact: true }).click();
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await page.route("**/sessions/s-poll", (route) =>
    route.fulfill({ status: 404, json: { error: "not found" } }),
  );
  await page.locator(".session-main").filter({ hasText: "s-poll" }).click();
  await expect(
    page.getByRole("heading", { name: "找不到这个会话" }),
  ).toBeVisible();
  await page
    .locator(".session-main")
    .filter({ hasText: "s-reread-same" })
    .click();
  await expect(page.locator(".session-view")).toBeVisible();
});

test("empty datasets explain how to start without looking like request failures", async ({
  page,
}) => {
  const overview = await (await page.request.get("/overview?days=8")).json();
  const zero = {
    raw: 0,
    uncached_input: 0,
    cached_input: 0,
    output: 0,
    credits: 0,
    usd: 0,
  };
  await page.route("**/sessions", (route) =>
    route.fulfill({ json: { sessions: [] } }),
  );
  await page.route("**/overview?**", (route) =>
    route.fulfill({
      json: {
        ...overview,
        sessionCount: 0,
        turnCount: 0,
        cost: zero,
        waste: zero,
        unpricedRaw: 0,
        days: [],
        models: [],
        slices: [],
        quality: {
          pricedRaw: 0,
          unpricedRaw: 0,
          ledgerWarningSessions: 0,
          parseErrors: 0,
        },
      },
    }),
  );
  await page.goto("/#overview");
  await expect(
    page.getByText("该时间范围内没有会话", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "前往会话导入" }).click();
  await expect(page.getByRole("heading", { name: "还没有会话" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "选择文件", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("import validates files before sending data", async ({ page }) => {
  let uploads = 0;
  await page.route("**/import", (route) => {
    uploads += 1;
    return route.fulfill({ status: 400, json: { error: "unexpected upload" } });
  });
  await openSessions(page);
  const input = page.getByLabel("选择会话 JSONL 文件");
  await input.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not a session"),
  });
  await expect(page.locator(".import-error")).toContainText(
    "只支持 .jsonl / .ndjson",
  );
  await input.setInputFiles({
    name: "empty.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from(" \n"),
  });
  await expect(page.locator(".import-error")).toContainText("文件没有内容");
  expect(uploads).toBe(0);
});

test("import blocks duplicate drops, shows pending state, and opens historical records", async ({
  page,
}) => {
  const snapshot = await (await page.request.get("/sessions/s-poll")).json();
  const pending = gate();
  let uploads = 0;
  await page.route("**/import", async (route) => {
    uploads += 1;
    await pending.promise;
    await route.fulfill({ json: snapshot });
  });
  await openSessions(page);
  await page.getByRole("button", { name: "5小时", exact: true }).click();
  const picker = page.getByRole("button", { name: "选择文件", exact: true });
  // Layout coordinates exclude browser scroll anchoring after a range change.
  const pickerLayout = () => picker.evaluate((element) => ({
    x: element.offsetLeft, y: element.offsetTop,
    width: element.offsetWidth, height: element.offsetHeight,
  }));
  const before = await pickerLayout();
  await page.getByLabel("选择会话 JSONL 文件").setInputFiles({
    name: "historical.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from('{"type":"session_meta"}\n'),
  });
  await expect(picker).toBeDisabled();
  await expect(picker).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#import-feedback")).toContainText(
    "正在导入 historical.jsonl",
  );
  expect(await pickerLayout()).toEqual(before);
  const drop = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(
      new File(["{}\n"], "duplicate.jsonl", { type: "application/x-ndjson" }),
    );
    return data;
  });
  await page
    .getByRole("complementary", { name: "会话列表" })
    .dispatchEvent("drop", { dataTransfer: drop });
  await drop.dispose();
  expect(uploads).toBe(1);
  pending.release();
  await expect(page.locator("#import-feedback")).toContainText(
    "已导入 historical.jsonl",
  );
  await expect(page.locator(".session-reference")).toHaveText("s-poll");
  await expect(
    page.getByRole("button", { name: "全部", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("import remains single-flight across navigation and completion respects the active view", async ({
  page,
}) => {
  const snapshot = await (await page.request.get("/sessions/s-poll")).json();
  const pending = gate();
  let uploads = 0;
  await page.route("**/import", async (route) => {
    uploads += 1;
    await pending.promise;
    await route.fulfill({ json: snapshot });
  });
  await openSessions(page);
  await page.getByRole("searchbox", { name: "筛选会话" }).fill("s-poll");
  await page.getByLabel("选择会话 JSONL 文件").setInputFiles({
    name: "background.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from("{}\n"),
  });
  await expect.poll(() => uploads).toBe(1);
  await page.getByRole("link", { name: "成本总览", exact: true }).click();
  await expect(page.locator(".app-notice")).toContainText(
    "正在导入 background.jsonl",
  );
  await page.getByRole("link", { name: "会话明细", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "选择文件", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("选择会话 JSONL 文件")).toBeDisabled();
  await expect(page.locator("#import-feedback")).toContainText(
    "正在导入 background.jsonl",
  );
  await page.getByRole("link", { name: "成本总览", exact: true }).click();
  pending.release();
  await expect(page.locator(".notice-success")).toContainText(
    "已导入 background.jsonl",
  );
  await expect(page).toHaveURL(/#overview$/);
  expect(uploads).toBe(1);
  await page
    .getByRole("button", { name: "查看导入的会话", exact: true })
    .click();
  await expect(page.locator(".session-reference")).toHaveText("s-poll");
  const search = page.getByRole("searchbox", { name: "筛选会话" });
  await expect(search).toHaveValue("");
  await search.fill("s-poll");
  await page.getByRole("link", { name: "成本总览", exact: true }).click();
  await page.getByRole("link", { name: "会话明细", exact: true }).click();
  await expect(search).toHaveValue("s-poll");
});

test("confirmed imports remain successful when follow-up list refresh fails", async ({
  page,
}) => {
  const snapshot = await (await page.request.get("/sessions/s-poll")).json();
  await openSessions(page);
  await page.route("**/import", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/sessions", (route) =>
    route.fulfill({ status: 503, json: { error: "read failed after commit" } }),
  );
  await page.getByLabel("选择会话 JSONL 文件").setInputFiles({
    name: "confirmed.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from("{}\n"),
  });
  await expect(page.locator("#import-feedback")).toContainText(
    "已导入 confirmed.jsonl",
  );
  await expect(page.locator(".session-reference")).toHaveText("s-poll");
  await expect(page.locator(".import-error")).toHaveCount(0);
  await expect(page.locator(".list-error")).toBeVisible();
});

test("uncertain import failure is actionable and never retries automatically", async ({
  page,
}) => {
  let uploads = 0;
  await page.route("**/import", (route) => {
    uploads += 1;
    return route.fulfill({ status: 503, json: { error: "unavailable" } });
  });
  await openSessions(page);
  await page.getByLabel("选择会话 JSONL 文件").setInputFiles({
    name: "retry.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from("{}\n"),
  });
  await expect(page.locator(".import-error")).toContainText("请先检查会话列表");
  await expect(
    page.getByRole("button", { name: "选择文件", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("#import-feedback")).not.toContainText("已导入");
  expect(uploads).toBe(1);
});

test("failed waste preferences roll back visibly and can be retried", async ({
  page,
}) => {
  const snapshot = await (await page.request.get("/sessions/s-poll")).json();
  await openSessions(page);
  await page
    .locator("summary")
    .filter({ hasText: "优化建议与浪费规则" })
    .click();
  const checkbox = page.getByRole("checkbox", { name: "轮询等待" });
  const original = await checkbox.isChecked();
  await page.route("**/waste-toggles", (route) =>
    route.fulfill({ status: 503, json: { error: "save failed" } }),
  );
  await checkbox.setChecked(!original);
  await expect(page.locator(".toggle-error")).toContainText("规则未能保存");
  await expect(checkbox).toBeChecked({ checked: original });
  await expect(page.locator(".toggle-status")).toHaveText("保存未确认");
  await page.unroute("**/waste-toggles");
  try {
    await page.getByRole("button", { name: "重试保存" }).click();
    await expect(page.locator(".toggle-status")).toHaveText("已保存");
    await expect(checkbox).toBeChecked({ checked: !original });
    await expect(page.locator(".toggle-error")).toHaveCount(0);
  } finally {
    await page.request.patch("/sessions/s-poll/waste-toggles", {
      data: snapshot.toggles,
    });
  }
});

test("turn evidence and chart tooltips work with keyboard and Escape", async ({
  page,
}) => {
  await page.goto("/#overview");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "跳到主要内容" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  const day = page.locator(".trend-col").first();
  await day.focus();
  await expect(day.locator(".chart-tooltip")).toBeVisible();
  await day.press("Escape");
  await expect(day.locator(".chart-tooltip")).toBeHidden();
  await page.getByRole("link", { name: "会话明细" }).click();
  await page.getByRole("button", { name: "全部", exact: true }).click();
  const expand = page.locator(".turn-expand").first();
  await expand.press("Enter");
  await expect(expand).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("Token 与费用明细")).toBeVisible();
  await expand.press("Space");
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("link", { name: "会话明细" }).focus();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("searchbox", { name: "筛选会话" })).toBeFocused();
});

for (const width of [1280, 390]) {
  test(`WCAG checks, global scrollbars, and complete evidence at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#overview");
    await expect(page.getByTestId("overview-page")).toBeVisible();
    const audit = () =>
      new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
    expect((await audit()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`overview-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("link", { name: "会话明细" }).click();
    await page.getByRole("button", { name: "全部", exact: true }).click();
    await expect(page.locator(".session-view")).toBeVisible();
    await page.locator(".turn-expand").first().click();
    await expect(page.getByLabel("Token 与费用明细")).toBeVisible();
    expect((await audit()).violations).toEqual([]);
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
    await expect(page.locator("html")).not.toHaveCSS("scrollbar-color", "auto");
    await expect(page.locator(".turn-table-scroll")).not.toHaveCSS(
      "scrollbar-color",
      "auto",
    );
    await page.screenshot({
      path: testInfo.outputPath(`session-${width}.png`),
      fullPage: true,
    });
    await page.emulateMedia({ forcedColors: "active" });
    await expect(page.locator("html")).toHaveCSS("scrollbar-color", "auto");
  });
}
