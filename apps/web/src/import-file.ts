export function isImportableFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".jsonl") || lower.endsWith(".ndjson");
}

export async function readDroppedFile(file: {
  name: string;
  text: () => Promise<string>;
}): Promise<{ filename: string; text: string }> {
  if (!isImportableFilename(file.name)) {
    throw new Error("只支持 .jsonl / .ndjson 文件");
  }
  return { filename: file.name, text: await file.text() };
}
