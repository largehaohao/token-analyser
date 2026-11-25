import { MessageChannel, Worker } from "node:worker_threads";
import type { IngestOptions } from "./ingest.ts";
import type { PreparedSource } from "./session-index.ts";

export type FileUpdate = { ids: string[]; updated: PreparedSource[] };
type Job = { kind: "parse"; file: string; options: IngestOptions; known: Map<string, string>; prices: string } |
  { kind: "migrate" | "prune"; home?: string; prices: string };
type Reply = { type: "rows"; updated: PreparedSource[] } | { type: "done"; ids: string[] } |
  { type: "retry" } | { type: "error"; message: string };

/** A single parser per store bounds memory when several large logs change together. */
export class BackgroundIngest {
  private worker?: Worker;
  private idle?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();

  read(file: string, options: IngestOptions, known: Map<string, string>, prices: string): Promise<FileUpdate | undefined> {
    return this.enqueue({ kind: "parse", file, options, known, prices });
  }

  async maintain(kind: "migrate" | "prune", home: string | undefined, prices: string): Promise<void> {
    await this.enqueue({ kind, home, prices });
  }

  private enqueue(job: Job): Promise<FileUpdate | undefined> {
    const result = this.queue.then(() => this.run(job));
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private async run(job: Job): Promise<FileUpdate | undefined> {
    if (this.idle) clearTimeout(this.idle);
    if (!this.worker) {
      const created = new Worker(new URL("./ingest-worker.mjs", import.meta.url), { execArgv: [] });
      const discard = () => { if (this.worker === created) this.worker = undefined; };
      created.once("error", discard);
      created.once("exit", discard);
      this.worker = created;
    }
    const worker = this.worker;
    const { port1, port2 } = new MessageChannel();
    const updated: PreparedSource[] = [];
    let fail!: (error: Error) => void;
    const exit = (code: number) => fail(new Error(`session parser exited (${code})`));
    try {
      return await new Promise<FileUpdate | undefined>((resolve, reject) => {
        fail = (error) => {
          this.worker = undefined;
          reject(error);
        };
        worker.once("error", fail);
        worker.once("exit", exit);
        port1.on("message", (reply: Reply) => {
          if (reply.type === "rows") {
            updated.push(...reply.updated);
            port1.postMessage("next");
          } else if (reply.type === "done") resolve({ ids: reply.ids, updated });
          else if (reply.type === "retry") resolve(undefined);
          else reject(new Error(reply.message));
        });
        port1.once("messageerror", reject);
        worker.postMessage({ port: port2, ...job }, [port2]);
      });
    } finally {
      port1.close();
      worker.off("exit", exit);
      worker.off("error", fail);
      worker.unref();
      // Keep worker alive for 5 minutes across live session bursts so tsx
      // compilation and incremental liveReadStates offsets are preserved.
      this.idle = setTimeout(() => {
        if (this.worker === worker) {
          this.worker = undefined;
          void worker.terminate();
        }
      }, 5 * 60_000);
      this.idle.unref();
    }
  }
}
