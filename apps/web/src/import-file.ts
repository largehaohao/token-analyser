export type ImportStatus =
  | { state: "pending"; filename: string }
  | { state: "success"; filename: string }
  | { state: "error"; filename: string; message: string };

export function isImportableFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".jsonl") || lower.endsWith(".ndjson");
}

export async function readDroppedFile(file: {
  name: string;
  size?: number;
  text: () => Promise<string>;
}): Promise<{ filename: string; text: string }> {
  if (!isImportableFilename(file.name)) {
    throw new Error(
      "只支持 .jsonl / .ndjson 文件，请重新选择 Codex 会话记录。",
    );
  }
  if (file.size != null && file.size > MAX_IMPORT_BYTES) {
    throw new Error("文件超过 256 MiB 上限，请选择较小的会话记录。");
  }
  const text = await file.text();
  if (!text.trim())
    throw new Error("文件没有内容，请选择包含会话记录的 JSONL 文件。");
  return { filename: file.name, text };
}
// Matches the import endpoint's default body limit; the server remains authoritative.
export const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
