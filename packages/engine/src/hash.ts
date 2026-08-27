import { createHash } from "node:crypto";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function preview(text: string, n = 200): string {
  return text.length <= n ? text : text.slice(0, n);
}
