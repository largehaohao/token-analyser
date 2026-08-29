import { describe, expect, it } from "vitest";
import { errorMessage, isNotFound, streamErrorBanner } from "./app-errors";

describe("isNotFound", () => {
  it("treats HTTP 404 as a missing session", () => {
    const err = Object.assign(new Error("HTTP 404: not_found"), { status: 404 });
    expect(isNotFound(err)).toBe(true);
    expect(isNotFound(new Error("HTTP 500"))).toBe(false);
  });
});

describe("streamErrorBanner", () => {
  it("surfaces the session_error reason", () => {
    expect(
      streamErrorBanner({
        type: "session_error",
        id: "s1",
        reason: "ENOENT",
      }),
    ).toBe("会话错误: ENOENT");
  });

  it("falls back to the session id when reason is missing", () => {
    expect(streamErrorBanner({ type: "session_error", id: "s1" })).toBe(
      "会话 s1 读取失败",
    );
  });

  it("ignores other stream events", () => {
    expect(streamErrorBanner({ type: "session_updated", id: "s1" })).toBeNull();
  });
});

describe("errorMessage", () => {
  it("keeps Error.message and otherwise uses the fallback", () => {
    expect(errorMessage(new Error("导入失败"), "fallback")).toBe("导入失败");
    expect(errorMessage("nope", "导入失败")).toBe("导入失败");
  });
});
