import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOverview,
  importNdjson,
  openStream,
  type StreamEvent,
} from "./api";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, ((ev: MessageEvent) => void)[]>();

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }
}

describe("openStream", () => {
  afterEach(() => {
    FakeEventSource.instances = [];
    vi.unstubAllGlobals();
  });

  it("asks the UI to resync when the SSE socket opens", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const events: StreamEvent[] = [];
    const statuses: string[] = [];
    const stop = openStream((event) => events.push(event), (status) =>
      statuses.push(status),
    );
    const es = FakeEventSource.instances[0]!;
    es.onopen?.(new Event("open"));
    expect(statuses).toEqual(["connecting", "open"]);
    expect(events).toEqual([{ type: "resync", id: "*" }]);
    stop();
    expect(es.closed).toBe(true);
  });

  it("forwards session_error reason from the event payload", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const events: StreamEvent[] = [];
    openStream((event) => events.push(event));
    const es = FakeEventSource.instances[0]!;
    const listeners = es.listeners.get("session_error") ?? [];
    listeners[0]!({
      data: JSON.stringify({ id: "s1", reason: "ENOENT" }),
    } as MessageEvent);
    expect(events).toEqual([
      { type: "session_error", id: "s1", reason: "ENOENT" },
    ]);
  });
});

describe("getOverview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the browser timezone so daily totals follow local calendar days", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getOverview("7d", Date.parse("2026-08-29T12:00:00.000Z"));

    const url = new URL(String(fetchMock.mock.calls[0]![0]), "http://localhost");
    expect(url.searchParams.has("timezone")).toBe(true);
    expect(url.searchParams.has("timezone_offset_minutes")).toBe(true);
  });
});

describe("importNdjson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("percent-encodes UTF-8 filenames in the request header", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/import");
      expect(new Headers(init?.headers).get("X-Filename")).toBe(
        "%E4%BC%9A%E8%AF%9D.ndjson",
      );
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await importNdjson("会话.ndjson", '{"type":"session_meta"}\n');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
