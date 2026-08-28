import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../src/store.ts";
import { watchSessions } from "../src/watch.ts";
import { DEFAULT_WASTE_TOGGLES } from "../src/types.ts";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted",
);

function parentFixture(): string {
  const waitPoll = readFileSync(
    path.join(fixtures, "wait-poll.jsonl"),
    "utf8",
  );
  return waitPoll.replace('"s-poll"', '"parent-1"').replace('"s-poll"', '"parent-1"');
}

describe("SessionStore", () => {
  it("joins parent and child, lists one root, and setToggles recomputes waste", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-"));
    const cacheDir = path.join(dir, "cache");
    const parentPath = path.join(dir, "rollout-parent.jsonl");
    const childPath = path.join(dir, "rollout-child.jsonl");
    writeFileSync(parentPath, parentFixture());
    writeFileSync(
      childPath,
      readFileSync(path.join(fixtures, "child-prefix.jsonl"), "utf8"),
    );

    const store = new SessionStore({ cacheDir });
    store.refresh([parentPath, childPath]);

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.id).toBe("parent-1");

    const parent = store.get("parent-1");
    expect(parent).toBeDefined();
    expect(parent!.children[0]!.nickname).toBe("Plato");

    const subagents = parent!.tree.children.find((c) => c.label === "subagents");
    expect(subagents!.cost.raw).toBe(parent!.children[0]!.cost.raw);

    store.setToggles("parent-1", {
      ...DEFAULT_WASTE_TOGGLES,
      poll: false,
      idle_subagents: false,
    });
    expect(store.get("parent-1")!.waste.raw).toBe(0);
  });

  it("preserves joined children when ingestPath re-reads parent and child", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-reingest-"));
    const cacheDir = path.join(dir, "cache");
    const parentPath = path.join(dir, "rollout-parent.jsonl");
    const childPath = path.join(dir, "rollout-child.jsonl");
    writeFileSync(parentPath, parentFixture());
    writeFileSync(
      childPath,
      readFileSync(path.join(fixtures, "child-prefix.jsonl"), "utf8"),
    );

    const store = new SessionStore({ cacheDir });
    store.refresh([parentPath, childPath]);

    const before = store.get("parent-1")!;
    const subagentsRaw = before.tree.children.find((c) => c.label === "subagents")!
      .cost.raw;

    store.ingestPath(parentPath);
    const afterParent = store.get("parent-1")!;
    expect(afterParent.children[0]!.nickname).toBe("Plato");
    expect(
      afterParent.tree.children.find((c) => c.label === "subagents")!.cost.raw,
    ).toBe(subagentsRaw);

    writeFileSync(
      childPath,
      readFileSync(childPath, "utf8").replace("Plato", "Aristotle"),
    );
    store.ingestPath(childPath);

    const after = store.get("parent-1")!;
    expect(after.children[0]!.nickname).toBe("Aristotle");
    const subagents = after.tree.children.find((c) => c.label === "subagents");
    expect(subagents!.cost.raw).toBe(after.children[0]!.cost.raw);
    expect(subagents!.children[0]!.label).toBe("Aristotle");
  });

  it("joins out-of-order nested children and propagates updates to the root", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-nested-"));
    const cacheDir = path.join(dir, "cache");
    const parentPath = path.join(dir, "rollout-parent.jsonl");
    const childPath = path.join(dir, "rollout-child.jsonl");
    const grandchildPath = path.join(dir, "rollout-grandchild.jsonl");
    const childText = readFileSync(path.join(fixtures, "child-prefix.jsonl"), "utf8");
    writeFileSync(parentPath, parentFixture());
    writeFileSync(childPath, childText);
    writeFileSync(
      grandchildPath,
      childText.replaceAll('"child-1"', '"grandchild-1"').replaceAll('"parent-1"', '"child-1"').replace("Plato", "Socrates"),
    );

    const store = new SessionStore({ cacheDir });
    store.ingestPath(childPath);
    store.ingestPath(grandchildPath);
    store.ingestPath(parentPath);

    const root = store.get("parent-1")!;
    expect(store.list().map((item) => item.id)).toEqual(["parent-1"]);
    expect(root.children[0]!.children[0]!.nickname).toBe("Socrates");
    const expectedRaw =
      root.turns.reduce((sum, turn) => sum + turn.cost.raw, 0) +
      root.children[0]!.turns.reduce((sum, turn) => sum + turn.cost.raw, 0) +
      root.children[0]!.children[0]!.turns.reduce((sum, turn) => sum + turn.cost.raw, 0);
    expect(root.cost.raw).toBe(expectedRaw);

    store.setToggles("parent-1", { poll: false });
    store.ingestPath(parentPath);
    expect(store.get("parent-1")!.toggles.poll).toBe(false);
  });

  it("refreshes the live flag after a file stops changing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "store-live-"));
    const filePath = path.join(dir, "rollout-live.jsonl");
    writeFileSync(filePath, parentFixture());
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    store.ingestPath(filePath);

    const realNow = Date.now;
    try {
      const initial = realNow();
      Date.now = () => initial + 121_000;
      expect(store.list()[0]!.live).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("watchSessions", () => {
  it("detects a new rollout file within 2s", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "watch-"));
    const cacheDir = path.join(dir, "cache");
    const store = new SessionStore({ cacheDir });
    const rolloutPath = path.join(dir, "rollout-new.jsonl");
    const line =
      '{"timestamp":"2026-08-27T00:00:00.000Z","type":"session_meta","payload":{"id":"w1","session_id":"w1"}}\n';

    const stop = watchSessions(store, () => {}, { watchPaths: [dir] });

    try {
      writeFileSync(rolloutPath, line);

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (store.list().length === 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]!.id).toBe("w1");
    } finally {
      stop();
    }
  });

  it("detects rollout files in nested subdirectories without recursive watch", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "watch-nested-"));
    const nested = path.join(dir, "2026", "08", "27");
    mkdirSync(nested, { recursive: true });
    const cacheDir = path.join(dir, "cache");
    const store = new SessionStore({ cacheDir });
    const rolloutPath = path.join(nested, "rollout-nested.jsonl");
    const line =
      '{"timestamp":"2026-08-27T00:00:00.000Z","type":"session_meta","payload":{"id":"nested-1","session_id":"nested-1"}}\n';

    const stop = watchSessions(store, () => {}, {
      watchPaths: [dir],
      recursive: false,
    });

    try {
      writeFileSync(rolloutPath, line);

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (store.list().length === 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]!.id).toBe("nested-1");
    } finally {
      stop();
    }
  });
});
