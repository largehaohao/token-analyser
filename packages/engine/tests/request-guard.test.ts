import { describe, expect, it } from "vitest";
import { isLoopbackHost, isStateChangeAllowed } from "../src/request-guard.ts";

describe("loopback host check", () => {
  it("accepts exact loopback authorities on the dev and serve ports", () => {
    expect(isLoopbackHost("127.0.0.1:7789")).toBe(true);
    expect(isLoopbackHost("localhost:7788")).toBe(true);
    expect(isLoopbackHost("localhost:7789")).toBe(true);
    expect(isLoopbackHost("[::1]:7789")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
  });

  it("does not treat a lookalike hostname as a prefix of localhost", () => {
    expect(isLoopbackHost("localhost.evil.com")).toBe(false);
    expect(isLoopbackHost("localhost.evil.com:7789")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.com:80")).toBe(false);
    expect(isLoopbackHost("evil.com")).toBe(false);
    expect(isLoopbackHost("localhost:7789evil")).toBe(false);
    expect(isLoopbackHost("notlocalhost")).toBe(false);
  });
});

describe("state-changing request guard", () => {
  it("allows curl with no Origin and rejects a missing Origin that is cross-site", () => {
    expect(isStateChangeAllowed({})).toBe(true);
    expect(isStateChangeAllowed({ "sec-fetch-site": "cross-site" })).toBe(false);
    expect(isStateChangeAllowed({ "sec-fetch-site": "same-origin" })).toBe(true);
    expect(isStateChangeAllowed({ "sec-fetch-site": "none" })).toBe(true);
  });

  it("still requires a loopback Origin when the browser sends one", () => {
    expect(isStateChangeAllowed({ origin: "http://127.0.0.1:7788" })).toBe(true);
    expect(isStateChangeAllowed({ origin: "http://localhost:7789" })).toBe(true);
    expect(isStateChangeAllowed({ origin: "https://evil.example" })).toBe(false);
    expect(isStateChangeAllowed({ origin: "http://localhost.evil.com" })).toBe(false);
    expect(isStateChangeAllowed({
      origin: "http://127.0.0.1:7788",
      "sec-fetch-site": "cross-site",
    })).toBe(false);
    expect(isStateChangeAllowed({ origin: "null" })).toBe(false);
  });
});
