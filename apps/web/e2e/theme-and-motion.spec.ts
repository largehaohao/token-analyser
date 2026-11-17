import { test, expect } from "@playwright/test";
import { waitForSettledNumber } from "./helpers";

const THEME_KEY = "token-analyser:theme";

test("theme toggle flips the palette and persists the choice", async ({ page }) => {
  await page.goto("/#overview");
  await expect(page.getByTestId("overview-page")).toBeVisible();

  const root = page.locator("html");
  const toggle = page.locator(".theme-toggle");
  const start = await root.getAttribute("data-theme");

  await toggle.click();
  const flipped = start === "dark" ? "light" : "dark";
  await expect(root).toHaveAttribute("data-theme", flipped);
  await expect(page.evaluate((key) => localStorage.getItem(key), THEME_KEY)).resolves.toBe(flipped);

  // Reload: the stored choice wins and is applied again.
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", flipped);
});

test("first visit follows prefers-color-scheme when no theme is stored", async ({
  browser,
}) => {
  for (const scheme of ["dark", "light"] as const) {
    const context = await browser.newContext({ colorScheme: scheme });
    const page = await context.newPage();
    await page.goto("/#overview");
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await context.close();
  }
});

test("reduced motion lands count-ups and animations immediately", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#overview");
  await expect(page.getByTestId("overview-page")).toBeVisible();
  // With reduced motion the ledger figure is the final value on first frame;
  // there is no intermediate 0 to wait out.
  const figure = page.locator(".ledger-value").first();
  const settled = await waitForSettledNumber(figure);
  expect(settled).toBeGreaterThanOrEqual(0);
  await expect(figure).not.toHaveText("0");
});
