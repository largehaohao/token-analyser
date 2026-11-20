import { describe, expect, it } from "vitest";
import { environmentLabel, normalizeEnvironment } from "./session-environment";

describe("session environments", () => {
  it("keeps the two supported machines and treats anything else as local", () => {
    expect(normalizeEnvironment("local")).toBe("local");
    expect(normalizeEnvironment("192.168.1.102")).toBe("192.168.1.102");
    expect(normalizeEnvironment("192.168.1.103")).toBe("local");
    expect(normalizeEnvironment(null)).toBe("local");
    expect(environmentLabel("192.168.1.102")).toBe("192.168.1.102");
    expect(environmentLabel("local")).toBe("本机");
  });
});
