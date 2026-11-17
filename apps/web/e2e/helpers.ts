import { expect, type Locator } from "@playwright/test";

/**
 * Count-up animations settle asynchronously. Read a value only after two
 * consecutive samples agree, so assertions never race the final frame.
 */
export async function waitForSettled<T>(
  read: () => Promise<T>,
  timeout = 5000,
): Promise<T> {
  let previous = await read();
  await expect
    .poll(
      async () => {
        const current = await read();
        const stable = current === previous;
        previous = current;
        return stable;
      },
      { timeout },
    )
    .toBe(true);
  return previous;
}

/** Numeric convenience wrapper around {@link waitForSettled}. */
export function waitForSettledNumber(locator: Locator, timeout = 5000) {
  return waitForSettled(
    async () => Number((await locator.innerText()).replace(/[^\d.]/g, "")),
    timeout,
  );
}
