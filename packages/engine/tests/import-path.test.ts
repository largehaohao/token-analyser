import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveImportTarget } from "../src/import-path.ts";

describe("resolveImportTarget", () => {
  it("resolves a session symlink to its real regular file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "import-link-"));
    const real = path.join(dir, "rollout.jsonl");
    writeFileSync(real, "{}\n");
    const link = path.join(dir, "alias.jsonl");
    symlinkSync(real, link);

    expect(resolveImportTarget(link)).toEqual({ ok: true, path: realpathSync(real) });
  });

  it("rejects a symlink whose target is not an allowed session file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "import-disguise-"));
    const secret = path.join(dir, "secret.txt");
    writeFileSync(secret, "nope");
    const disguised = path.join(dir, "state.vscdb");
    symlinkSync(secret, disguised);

    expect(resolveImportTarget(disguised)).toEqual({ ok: false, error: "invalid_path" });
  });

  it("rejects directories and other special files before they can be opened", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "import-special-"));
    const asDir = path.join(dir, "not-a-file.jsonl");
    mkdirSync(asDir);
    expect(resolveImportTarget(asDir)).toEqual({ ok: false, error: "invalid_path" });

    const fifo = path.join(dir, "pipe.jsonl");
    const made = spawnSync("mkfifo", [fifo], { stdio: "ignore" });
    if (made.status === 0) {
      expect(resolveImportTarget(fifo)).toEqual({ ok: false, error: "invalid_path" });
    }
  });

  it("keeps a missing session path for ingest, and rejects other extensions", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "import-missing-"));
    const missing = path.join(dir, "missing-rollout.jsonl");
    expect(resolveImportTarget(missing)).toEqual({ ok: true, path: missing });
    expect(resolveImportTarget(path.join(dir, "notes.txt"))).toEqual({
      ok: false,
      error: "invalid_path",
    });
    expect(resolveImportTarget("relative.jsonl")).toEqual({
      ok: false,
      error: "invalid_path",
    });
  });
});
