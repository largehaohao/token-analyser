export function overviewDisplayState(args: {
  requestedRange: string;
  appliedRange: string | null;
  hasOverview: boolean;
  error: string | null;
}): "loading" | "error" | "ready" {
  if (args.error && args.appliedRange !== args.requestedRange) return "error";
  if (!args.hasOverview || args.appliedRange !== args.requestedRange) {
    return "loading";
  }
  return "ready";
}
