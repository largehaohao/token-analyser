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
  const input = page.getByLabel("选择 rollout JSONL 文件");
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
  await page.getByRole("button", { name: "5小时" }).click();
  const picker = page.getByRole("button", { name: "选择文件", exact: true });
  const before = await picker.boundingBox();
  await page.getByLabel("选择 rollout JSONL 文件").setInputFiles({
    name: "historical.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from('{"type":"session_meta"}\n'),
  });
  await expect(picker).toBeDisabled();
  await expect(picker).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#import-feedback")).toContainText(
    "正在导入 historical.jsonl",
  );
  expect(await picker.boundingBox()).toEqual(before);
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
  await page.getByLabel("选择 rollout JSONL 文件").setInputFiles({
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
  await expect(page.getByLabel("选择 rollout JSONL 文件")).toBeDisabled();
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
  await page.getByLabel("选择 rollout JSONL 文件").setInputFiles({
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
  await page.getByLabel("选择 rollout JSONL 文件").setInputFiles({
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
