import { describe, expect, it } from "vitest";
import { extractReadPaths, isReadCommand, isWriteOrTest } from "../src/exec-command.ts";

describe("extractReadPaths", () => {
  it("takes file operands and ignores flags", () => {
    expect(extractReadPaths("cat README.md")).toEqual(["README.md"]);
    expect(extractReadPaths("rg -n TODO src/app.ts")).toEqual(["src/app.ts"]);
    expect(extractReadPaths("sed -n '1,10p' foo.rs")).toEqual(["foo.rs"]);
    expect(isReadCommand(`bash -lc "cat README.md"`)).toBe(true);
  });
});

describe("isWriteOrTest", () => {
  it("detects patches and tests", () => {
    expect(isWriteOrTest("git apply /tmp/x.patch")).toBe(true);
    expect(isWriteOrTest("pnpm test")).toBe(true);
    expect(isWriteOrTest("python foo.py")).toBe(true);
    expect(isWriteOrTest("python3 foo.py")).toBe(true);
    expect(isWriteOrTest("cat README.md")).toBe(false);
  });

  it("unwraps bash -lc / argv JSON and ignores stdin redirection", () => {
    expect(extractReadPaths(`bash -lc "cat README.md"`)).toEqual(["README.md"]);
    expect(extractReadPaths(`{"cmd":["cat","README.md"]}`)).toEqual(["README.md"]);
    expect(extractReadPaths("cat foo.ts | rg bar")).toEqual(["foo.ts"]);
    expect(isWriteOrTest(`bash -lc "python foo.py"`)).toBe(true);
    expect(isWriteOrTest("grep foo < bar.txt")).toBe(false);
    expect(isWriteOrTest("cat foo > bar")).toBe(true);
  });
});
