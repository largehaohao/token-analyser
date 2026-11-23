import { describe, expect, it } from "vitest";
import { isNodeVersionSupported, unsupportedNodeMessage } from "../src/node-guard.ts";

describe("node version guard", () => {
  it("requires a release with Zstandard support", () => {
    expect(isNodeVersionSupported("22.13.0")).toBe(false);
    expect(isNodeVersionSupported("22.14.0")).toBe(false);
    expect(isNodeVersionSupported("22.15.0")).toBe(true);
    expect(isNodeVersionSupported("v22.15.1")).toBe(true);
    expect(isNodeVersionSupported("23.7.0")).toBe(false);
    expect(isNodeVersionSupported("23.8.0")).toBe(true);
    expect(isNodeVersionSupported("26.13.0")).toBe(true);
    expect(isNodeVersionSupported("20.19.0")).toBe(false);
    expect(isNodeVersionSupported("22.12.9")).toBe(false);
    expect(isNodeVersionSupported("22.13")).toBe(false);
  });

  it("names the required version and node:sqlite in the startup error", () => {
    const message = unsupportedNodeMessage("v20.19.0");
    expect(message).toContain("22.15.0+ (22.x) or 23.8+");
    expect(message).toContain("v20.19.0");
    expect(message).toContain("node:sqlite");
    expect(message).toContain(".nvmrc");
  });
});
