import { afterEach, describe, expect, it, vi } from "vitest";
import { openStream, type StreamEvent } from "./api";

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
