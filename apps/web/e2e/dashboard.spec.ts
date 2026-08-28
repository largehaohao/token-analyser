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
  await firstRequest;
  await page.getByRole("button", { name: /s-reread-same/ }).click();
  const total = page.locator(".headline-row").first().locator(".headline-value");
  await expect(total).toHaveText(second!.cost.raw.toLocaleString("en-US"));
  releaseFirst();
  await expect(total).toHaveText(second!.cost.raw.toLocaleString("en-US"));
});
