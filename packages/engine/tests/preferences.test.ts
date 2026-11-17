import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../src/store.ts";
import { DEFAULT_WASTE_TOGGLES } from "../src/types.ts";
import {
  closeStoreDb,
  readStoredToggles,
  storeDbPath,
} from "../src/store-db.ts";
import { STORE_DUMP_VERSION, writeStoreDump } from "../src/store-dump.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/redacted",
);
const dirs: string[] = [];
function home(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "preferences-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  dirs.splice(0).forEach((dir) => {
    closeStoreDb(dir);
    rmSync(dir, { recursive: true, force: true });
  });
});

function opencodeDb(dir: string) {
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session_v2 (
      id text PRIMARY KEY, parent_id text, directory text, title text,
      time_created integer, time_updated integer, model text
    );
    CREATE TABLE session_message (
      id text PRIMARY KEY, session_id text, type text, time_created integer, data text
    );
    CREATE TABLE part (
      id text PRIMARY KEY, message_id text, session_id text, time_created integer, data text
    );
  `);
  const created = 1_760_000_000_000;
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "ses_a", null, "/tmp/demo", "A", created, created + 5_000, null,
  );
  db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
    "msg_a", "ses_a", "assistant", created + 4_000,
    JSON.stringify({
      model: { id: "claude-sonnet-4-6", providerID: "opencode" },
      text: "Done.",
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 }, total: 120 },
    }),
  );
  return { file, db, created };
}

describe("waste preference lifecycle", () => {
  it("keeps saved toggles across a batched refresh of a changed database", async () => {
    const dir = home();
    const { file, db, created } = opencodeDb(dir);
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    await store.ingestPathBatched(file);
    store.setToggles("opencode:ses_a", { poll: false });
    expect(store.get("opencode:ses_a")!.toggles.poll).toBe(false);

    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)").run(
      "msg_a2", "ses_a", "assistant", created + 8_000,
      JSON.stringify({
        model: { id: "claude-sonnet-4-6", providerID: "opencode" },
        text: "More.",
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 12 },
      }),
    );
    await store.ingestPathBatched(file);
    expect(store.get("opencode:ses_a")!.toggles.poll).toBe(false);
    expect(readStoredToggles(dir)["opencode:ses_a"]).toMatchObject({ poll: false });
    db.close();
  });

  it("restores preferences after a pricing-context rebuild", () => {
    const dir = home();
    const rollout = path.join(dir, "rollout.jsonl");
    writeFileSync(rollout, readFileSync(path.join(fixtures, "wait-poll.jsonl")));
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    store.refresh([rollout]);
    const id = store.list()[0]!.id;
    store.setToggles(id, { poll: false });
    store.dump();

    // A pricing change invalidates derived snapshots but not preferences.
    writeStoreDump(
      {
        version: STORE_DUMP_VERSION,
        pricingContext: "different-pricing",
        sources: [],
        toggles: {},
        fingerprints: {},
      },
      dir,
    );
    const rebuilt = new SessionStore({ cacheDir: path.join(dir, "cache") });
    expect(rebuilt.loadDump()).toBe(0);
    rebuilt.refresh([rollout]);
    expect(rebuilt.get(id)!.toggles.poll).toBe(false);
  });

  it("removes ghost sessions and prunes preferences when a database empties", async () => {
    const dir = home();
    const { file, db } = opencodeDb(dir);
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    await store.ingestPathBatched(file);
    store.setToggles("opencode:ses_a", { poll: false });
    expect(store.list()).toHaveLength(1);

    db.exec("DELETE FROM session_message");
    db.exec("DELETE FROM session_v2");
    await store.ingestPathBatched(file);
    expect(store.list()).toHaveLength(0);
    expect(store.get("opencode:ses_a")).toBeUndefined();
    expect(readStoredToggles(dir)["opencode:ses_a"]).toBeUndefined();
    db.close();
  });

  it("keeps the database file when only derived data is invalid", () => {
    const dir = home();
    writeStoreDump(
      {
        version: STORE_DUMP_VERSION - 1,
        pricingContext: "",
        sources: [],
        toggles: {},
        fingerprints: {},
      },
      dir,
    );
    const store = new SessionStore({ cacheDir: path.join(dir, "cache") });
    expect(store.loadDump()).toBe(0);
    expect(existsSync(storeDbPath(dir))).toBe(true);
  });
});
