export type HttpError = Error & { status?: number };

export function isNotFound(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      "status" in err &&
      (err as HttpError).status === 404,
  );
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function streamErrorBanner(event: {
  type: string;
  id: string;
  reason?: string;
}): string | null {
  if (event.type !== "session_error") return null;
  return event.reason
    ? `会话错误: ${event.reason}`
    : `会话 ${event.id} 读取失败`;
}
