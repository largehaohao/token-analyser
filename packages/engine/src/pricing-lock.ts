/**
 * Serializes every pricing-file mutation (manual update, hourly Qwen refresh)
 * so overlapping runs cannot interleave writes or roll back each other's
 * committed rates.
 */
let queue: Promise<unknown> = Promise.resolve();

export function withPricingLock<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
