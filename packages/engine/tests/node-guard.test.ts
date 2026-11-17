import { describe, expect, it } from "vitest";
import { isNodeVersionSupported, unsupportedNodeMessage } from "../src/node-guard.ts";

describe("node version guard", () => {
  it("accepts 22.13 and newer, and rejects older LTS lines", () => {
    expect(isNodeVersionSupported("22.13.0")).toBe(true);
    expect(isNodeVersionSupported("v22.13.1")).toBe(true);
    expect(isNodeVersionSupported("22.14.0")).toBe(true);
    expect(isNodeVersionSupported("26.13.0")).toBe(true);
    expect(isNodeVersionSupported("20.19.0")).toBe(false);
    expect(isNodeVersionSupported("22.12.9")).toBe(false);
    expect(isNodeVersionSupported("22.13")).toBe(false);
  });

  it("names the required version and node:sqlite in the startup error", () => {
    const message = unsupportedNodeMessage("v20.19.0");
    expect(message).toContain(">= 22.13.0");
    expect(message).toContain("v20.19.0");
    expect(message).toContain("node:sqlite");
    expect(message).toContain(".nvmrc");
  });
});
