import { test, expect } from "@playwright/test";

test("tree percents sum to ~100 and waste moves when poll is unchecked", async ({
  page,
}) => {
  await page.goto("/");
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
