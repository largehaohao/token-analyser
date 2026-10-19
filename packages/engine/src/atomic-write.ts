import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Replace a file's content through a same-directory temporary file so a crash
 * can never leave a half-written config behind.
 */
export function writeFileAtomically(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, content, "utf8");
    renameSync(temporaryPath, filePath);
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may already have been renamed or removed.
    }
    throw new Error("config_write_failed");
  }
}
