/**
 * Runtime feature flags. Read on each request so a restarted engine picks up
 * the environment without a frontend rebuild. Vite `VITE_*` variables are
 * intentionally ignored: they are frozen into the bundle at `pnpm build`.
 */
export function powerPreviewEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.ENABLE_POWER_PREVIEW?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
