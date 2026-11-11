/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiTarget = process.env.TOKEN_ANALYSER_API_URL ?? "http://127.0.0.1:7789";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
    proxy: {
      "/sessions": apiTarget,
      "/overview": apiTarget,
      "/power": apiTarget,
      "/temps": apiTarget,
      "/stream": { target: apiTarget, ws: false },
      "/import": apiTarget,
      "/pricing": apiTarget,
    },
  },
  build: { outDir: "dist" },
});
