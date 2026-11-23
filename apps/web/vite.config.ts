/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiTarget = process.env.TOKEN_ANALYSER_API_URL ?? "http://127.0.0.1:7789";

const proxy = {
  "/sessions": apiTarget, "/overview": apiTarget, "/power": apiTarget, "/temps": apiTarget,
  "/stream": { target: apiTarget, ws: false }, "/import": apiTarget, "/pricing": apiTarget,
  "/prices": apiTarget, "/config": apiTarget, "/environments": apiTarget,
};

// Vite can prepare the UI while its sibling engine opens the port. Only API
// requests wait for the new engine, including during a same-port restart.
function waitForManagedEngine(): Plugin {
  return {
    name: "local-engine-readiness", apply: "serve",
    configureServer(server) {
      if (process.env.TOKEN_ANALYSER_MANAGED_DEV !== "1" || !process.send) return;
      let listening = false;
      const ready = new Promise<void>((resolve) => {
        function received(message: unknown) {
          if ((message as { type?: string } | null)?.type !== "engine-listening") return;
          listening = true;
          process.off("message", received);
          resolve();
        }
        process.on("message", received);
        server.httpServer?.once("close", () => process.off("message", received));
      });
      server.middlewares.use((req, res, next) => {
        const route = "/" + req.url?.split(/[/?]/)[1];
        if (listening || !Object.hasOwn(proxy, route)) return next();
        void ready.then(() => { if (!res.destroyed) next(); });
      });
      process.send({ type: "proxy-waiting" });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), waitForManagedEngine()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  server: {
    host: "127.0.0.1",
    port: 7788,
    warmup: { clientFiles: ["./src/main.tsx", "./src/App.tsx", "./src/shadcn.css", "./src/styles.css"] },
    proxy,
  },
  build: { outDir: "dist" },
});
