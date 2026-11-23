import { parentPort } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const { ingestFile, readMultiSessionEvents, snapshotFromEvents, pricingCacheContext } = await import("./ingest.ts");
const { prepareSource, encodeIndex } = await import("./session-index.ts");
const { once } = await import("node:events");

parentPort.on("message", async ({ port, kind, home, file, options, known, prices }) => {
  try {
    if (kind === "migrate" || kind === "prune") {
      if (kind === "migrate") {
        const { readStoreIndex } = await import("./store-dump.ts");
        readStoreIndex(home, prices);
      } else {
        const { pruneStaleCache } = await import("./cache.ts");
        pruneStaleCache(home, prices);
      }
      port.postMessage({ type: "done", ids: [] });
      return;
    }
    if (pricingCacheContext() !== prices) {
      port.postMessage({ type: "retry" });
      return;
    }
    const ids = [];
    let updated = [];
    let bytes = 0;
    async function flush() {
      const ack = once(port, "message");
      port.postMessage({ type: "rows", updated });
      updated = [];
      bytes = 0;
      await ack;
    }

    const groups = readMultiSessionEvents(file);
    const count = groups?.length ?? 1;
    for (let i = 0; i < count; i += 1) {
      const snapshot = groups ? snapshotFromEvents(groups[i], file) : ingestFile(file, options);
      if (groups) groups[i] = [];
      ids.push(snapshot.id);
      const prepared = prepareSource(snapshot);
      if (known.get(snapshot.id) === prepared.index.revision) continue;
      prepared.packedIndex = encodeIndex(prepared.index);
      updated.push(prepared);
      bytes += prepared.json.length;
      if (bytes >= 1024 * 1024 || updated.length >= 16) await flush();
    }
    if (updated.length) await flush();
    port.postMessage(pricingCacheContext() === prices ? { type: "done", ids } : { type: "retry" });
  } catch (error) {
    port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    port.close();
  }
});
