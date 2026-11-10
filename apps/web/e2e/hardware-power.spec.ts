import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const PRESETS = [
  "近10分钟",
  "近1小时",
  "近12小时",
  "近1天",
  "近7天",
  "近30天",
] as const;

async function chartShowsLatest(page: Page) {
  const scroller = page.getByTestId("power-chart-scroll");
  await expect(scroller).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () =>
      scroller.evaluate((el) => {
        const node = el as HTMLElement;
        if (node.querySelectorAll(".power-col").length < 2) return false;
        return node.scrollLeft + node.clientWidth >= node.scrollWidth - 24;
      }),
    )
    .toBe(true);
}

test("hardware energy follows its range and price without entering token costs", async ({ page }) => {
  await page.goto("/#power");
  await expect(page.getByRole("heading", { name: "硬件用电", exact: true })).toBeVisible();
  const totals = page.getByRole("region", { name: "所选范围累计用电与电费", exact: true });
  // 默认电价为 0.6629 元/kWh，用电量与电费以大字号摘要展示。
  await expect(page.getByRole("spinbutton", { name: "电价（元/kWh）" })).toHaveValue("0.6629");
  const hero = page.getByTestId("power-energy-hero");
  await expect(hero).toBeVisible();
  await expect(totals).toContainText("电价 0.6629 元/kWh");
  const heroFontSize = await hero
    .locator(".power-hero-value")
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(heroFontSize).toBeGreaterThanOrEqual(28);
  const range = page.getByRole("group", { name: "时间范围" });
  await expect(range.getByRole("button", { name: "近1小时", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // 默认近1小时：采集 15 秒，曲线 30 秒均值；终点贴着当前时刻。
  const grid = page.getByRole("status").filter({ hasText: "当前统计范围" });
  await expect(grid).toContainText("采集粒度每 15 秒");
  await expect(grid).toContainText("曲线均值粒度每 30 秒");
  await expect(grid).toContainText("近1小时");
  await expect(page.getByTestId("power-trend")).toContainText("近1小时");
  await expect(page.getByTestId("power-trend")).toContainText("峰值见悬停");
  expect(await page.locator(".power-col").count()).toBeLessThanOrEqual(150);
  const summary = page.getByTestId("power-summary");
  await expect(summary).toContainText("近1小时用电量");
  await expect(summary).toContainText("电价 0.6629 元/kWh");
  const energy = async () => Number((await totals.locator(".ledger-value").first().innerText()).replace(/[^\d.]/g, ""));
  const hourEnergy = await energy();
  await range.getByRole("button", { name: "近1天", exact: true }).click();
  await expect(grid).toContainText("采集粒度每 1 分钟");
  await expect(grid).toContainText("曲线均值粒度每 10 分钟");
  await expect(summary).toContainText("近1天用电量");
  expect(await energy()).toBeGreaterThan(hourEnergy);
  await range.getByRole("button", { name: "近1小时", exact: true }).click();
  await expect(grid).toContainText("采集粒度每 15 秒");
  const hourEnergyAgain = await energy();
  await page.getByRole("spinbutton", { name: "电价（元/kWh）" }).fill("1.10");
  await expect(totals).toContainText("电价 1.10 元/kWh");
  expect(await energy()).toBeCloseTo(hourEnergyAgain, 2);
  const money = Number((await totals.locator(".ledger-value").last().innerText()).replace(/[^\d.]/g, ""));
  expect(Math.abs(money - hourEnergyAgain * 1.1)).toBeLessThan(0.006);
  await expect(page.getByRole("status").filter({ hasText: "演示数据，尚未接入" })).toBeVisible();
  await page.getByRole("link", { name: "成本总览", exact: true }).click();
  await expect(page.getByTestId("power-page")).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "硬件用电", exact: true })).toBeVisible();
});

test("power trend presets share the summary window and show the latest samples", async ({ page }) => {
  await page.goto("/#hardware/power");
  const trend = page.getByTestId("power-trend");
  const range = trend.getByRole("group", { name: "时间范围" });
  const summary = page.getByTestId("power-summary");
  await expect(range.getByRole("button", { name: "近1小时", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await chartShowsLatest(page);

  for (const label of PRESETS) {
    await range.getByRole("button", { name: label, exact: true }).click();
    await expect(range.getByRole("button", { name: label, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(summary).toContainText(`${label}用电量`);
    await expect(trend).toContainText(label);
    await chartShowsLatest(page);
  }

  await range.getByRole("button", { name: "自定义", exact: true }).click();
  await expect(page.getByLabel("开始时间", { exact: true })).toBeVisible();
  await expect(page.getByLabel("结束时间", { exact: true })).toBeVisible();
  await expect(summary).toContainText("自定义范围用电量");
});

test("custom dates validate and render without overflow at 390px", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#power");
  await page.getByRole("button", { name: "自定义", exact: true }).click();
  await page.getByLabel("开始时间", { exact: true }).fill("2026-10-22T00:00");
  await page.getByLabel("结束时间", { exact: true }).fill("2026-10-21T00:00");
  await page.getByRole("button", { name: "应用自定义范围", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("结束时间必须晚于开始时间");
  await page.getByLabel("结束时间", { exact: true }).fill("2026-10-23T00:00");
  await page.getByRole("button", { name: "应用自定义范围", exact: true }).click();
  await expect(page.getByRole("region", { name: "统计范围与电价", exact: true }))
    .toContainText("10-22 00:00 → 10-23 00:00");
  await expect(page.getByTestId("power-summary")).toContainText("自定义范围用电量");
  await chartShowsLatest(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("hardware-power-mobile.png"), fullPage: true });
});
