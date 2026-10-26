import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("hardware energy follows its range and price without entering token costs", async ({ page }) => {
  await page.goto("/#power");
  await expect(page.getByRole("heading", { name: "硬件用电", exact: true })).toBeVisible();
  const totals = page.getByRole("region", { name: "所选范围累计用电与电费", exact: true });
  const energy = async () => Number((await totals.locator(".ledger-value").first().innerText()).replace(/[^\d.]/g, ""));
  const dayEnergy = await energy();
  await page.getByRole("button", { name: "近1小时", exact: true }).click();
  expect(await energy()).toBeLessThan(dayEnergy);
  const hourEnergy = await energy();
  await page.getByRole("spinbutton", { name: "电价（元/kWh）" }).fill("1.10");
  await expect(totals).toContainText("电价 1.10 元/kWh");
  expect(await energy()).toBeCloseTo(hourEnergy, 2);
  const money = Number((await totals.locator(".ledger-value").last().innerText()).replace(/[^\d.]/g, ""));
  expect(Math.abs(money - hourEnergy * 1.1)).toBeLessThan(0.006);
  await expect(page.getByRole("status").filter({ hasText: "演示数据，尚未接入" })).toBeVisible();
  await page.getByRole("link", { name: "成本总览", exact: true }).click();
  await expect(page.getByTestId("power-page")).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "硬件用电", exact: true })).toBeVisible();
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const a11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("hardware-power-mobile.png"), fullPage: true });
});
